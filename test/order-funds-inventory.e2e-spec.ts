import { Test, type TestingModule } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { Pool } from 'pg';
import { USER_ROLE } from '../src/shared/infrastructure/tenant/user-role.js';
import { describeWithTestDatabase, testDatabaseUrl } from './helpers/test-database.js';
const testJwtSecret = 'order-flow-e2e-secret-with-more-than-32-bytes';
const tenantId = `order-flow-${randomUUID()}`;
const tenantToken = createTenantToken(tenantId);

describeWithTestDatabase('order wallet and inventory flow (e2e)', () => {
  let app: INestApplication<App>;
  let adminPool: Pool;
  let migrationPool: Pool;
  let schema: string;
  let worker: { runOnce(): Promise<void> };

  beforeAll(async () => {
    process.env.AUTH_JWT_SECRET = testJwtSecret;
    process.env.SAGA_MAX_ATTEMPTS = '1';
    process.env.SAGA_POLL_INTERVAL_MS = '60000';

    schema = `order_flow_${randomUUID().replaceAll('-', '')}`;
    adminPool = new Pool({ connectionString: testDatabaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scopedUrl = new URL(testDatabaseUrl!);
    scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
    migrationPool = new Pool({ connectionString: scopedUrl.toString() });
    for (const migration of readdirSync(join(process.cwd(), 'src/shared/infrastructure/database/migrations'))
      .filter((file) => file.endsWith('.sql')).sort()) {
      await migrationPool.query(readFileSync(join(process.cwd(), 'src/shared/infrastructure/database/migrations', migration), 'utf8'));
    }

    // AppModule reads the database connection string when its database module loads.
    process.env.DATABASE_URL = scopedUrl.toString();
    const [{ AppModule }, { AuthUserRepository }, { FulfillmentSagaWorker }] = await Promise.all([
      import('../src/app.module.js'),
      import('../src/shared/infrastructure/tenant/auth-user.repository.js'),
      import('../src/modules/fulfillment-saga/infrastructure/fulfillment-saga.worker.js'),
    ]);
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AuthUserRepository)
      .useValue({ findById: async (id: string) => id === 'order-flow-user' ? {
        id, username: id, passwordHash: '', role: null,
        tenantRoles: [{ tenantId, role: USER_ROLE.OPERATOR }], active: true,
      } : undefined })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    worker = app.get(FulfillmentSagaWorker);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await migrationPool?.end();
    if (schema) await adminPool?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool?.end();
  });

  it('fails an order with insufficient wallet funds and leaves inventory available', async () => {
    const walletId = `wallet-${randomUUID()}`;
    const itemId = `sku-${randomUUID()}`;
    await createWallet(walletId);
    await createItem(itemId, 4);

    const order = await createOrder(itemId, walletId, 2, '1000');
    await worker.runOnce();

    await expectOrderState(order.id, 'FAILED');
    await expectInventory(itemId, { availableQty: 4, reservedQty: 0 });
    await expectWalletBalance(walletId, '0');
  });

  it('fails when funds are sufficient but inventory is not, without charging the wallet', async () => {
    const walletId = `wallet-${randomUUID()}`;
    const itemId = `sku-${randomUUID()}`;
    await createWallet(walletId);
    await fundWallet(walletId, '2000');
    await createItem(itemId, 1);

    const order = await createOrder(itemId, walletId, 2, '500');
    await worker.runOnce();

    await expectOrderState(order.id, 'FAILED');
    await expectInventory(itemId, { availableQty: 1, reservedQty: 0 });
    await expectWalletBalance(walletId, '2000');
  });

  it('confirms the order and settles funds when both wallet and inventory are sufficient', async () => {
    const walletId = `wallet-${randomUUID()}`;
    const itemId = `sku-${randomUUID()}`;
    await createWallet(walletId);
    await fundWallet(walletId, '2000');
    await createItem(itemId, 3);

    const order = await createOrder(itemId, walletId, 2, '500');
    await worker.runOnce();

    await expectOrderState(order.id, 'CONFIRMED');
    await expectInventory(itemId, { availableQty: 1, reservedQty: 2 });
    await expectWalletBalance(walletId, '1500');
  });

  function authHeaders() {
    return { Authorization: `Bearer ${tenantToken}`, 'X-Tenant-Id': tenantId };
  }

  async function createWallet(walletId: string): Promise<void> {
    await request(app.getHttpServer()).post('/ledger/wallets').set(authHeaders()).set('Idempotency-Key', `create-${walletId}`)
      .send({ walletId, name: 'Order flow wallet' }).expect(201);
  }

  async function fundWallet(walletId: string, amount: string): Promise<void> {
    await request(app.getHttpServer()).post('/ledger/entries').set(authHeaders()).set('Idempotency-Key', `fund-${walletId}`)
      .send({
        id: `fund-${walletId}`, description: 'Test wallet funding',
        lines: [
          { accountId: `wallet-account:${walletId}`, side: 'DEBIT', amount: { minorUnits: amount, currency: 'USD' } },
          { accountId: 'platform:order-clearing', side: 'CREDIT', amount: { minorUnits: amount, currency: 'USD' } },
        ],
      }).expect(201);
  }

  async function createItem(itemId: string, totalQty: number): Promise<void> {
    await request(app.getHttpServer()).post('/inventory/items').set(authHeaders()).send({ id: itemId, totalQty }).expect(201);
  }

  async function createOrder(itemId: string, walletId: string, quantity: number, amount: string): Promise<{ id: string }> {
    const response = await request(app.getHttpServer()).post('/orders').set(authHeaders()).set('Idempotency-Key', `order-${randomUUID()}`)
      .send({
        inventoryItemId: itemId, quantity,
        payment: {
          id: `payment-${randomUUID()}`, description: 'Order payment', walletId,
          amount: { minorUnits: amount, currency: 'USD' },
        },
      }).expect(202);
    return response.body as { id: string };
  }

  async function expectOrderState(orderId: string, state: string): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await worker.runOnce();
      const response = await request(app.getHttpServer()).get(`/orders/${orderId}`).set(authHeaders()).expect(200);
      if (response.body.state === state) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Order ${orderId} did not reach ${state}`);
  }

  async function expectInventory(itemId: string, expected: { availableQty: number; reservedQty: number }): Promise<void> {
    await request(app.getHttpServer()).get(`/inventory/items/${itemId}`).set(authHeaders()).expect(200).expect(({ body }) => expect(body).toMatchObject(expected));
  }

  async function expectWalletBalance(walletId: string, balanceMinorUnits: string): Promise<void> {
    await request(app.getHttpServer()).get(`/ledger/wallets/${walletId}/balance`).set(authHeaders()).expect(200).expect(({ body }) => {
      expect(body).toMatchObject([{ balanceMinorUnits, currency: 'USD' }]);
    });
  }
});

function createTenantToken(tenant: string, subject = 'order-flow-user'): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: subject, tenant_id: tenant, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  const signature = createHmac('sha256', testJwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
