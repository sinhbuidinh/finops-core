import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { FulfillmentSagaService } from '../src/modules/fulfillment-saga/fulfillment-saga.service.js';
import { OrdersController } from '../src/modules/fulfillment-saga/orders.controller.js';
import { AppController } from '../src/app.controller.js';
import { AppService } from '../src/app.service.js';
import { FulfillmentSaga } from '../src/modules/fulfillment-saga/application/fulfillment-saga.js';
import type { SagaStep } from '../src/modules/fulfillment-saga/application/saga-step.js';
import { TenantModule } from '../src/shared/infrastructure/tenant/tenant.module.js';

const testJwtSecret = 'test-only-secret-with-more-than-32-bytes';
const tenantToken = createTenantToken('tenant-1');
const multiTenantToken = createTenantToken(['tenant-1', 'tenant-2']);

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [AppService],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  it('/ (GET)', () => {
    return request(app.getHttpServer())
      .get('/')
      .expect(200)
      .expect('Hello World!');
  });

  afterEach(async () => {
    await app?.close();
  });
});

describe('Orders HTTP (e2e)', () => {
  let app: INestApplication<App>;
  const orders = new Map<string, { id: string; tenantId: string; state: string; sagaId: string }>();
  let reservedQuantity = 0;
  const service = {
    createOrder: vi.fn(async (input: { tenantId: string; quantity: number; payment: { id: string } }, _key: string) => {
      const id = `order-${orders.size + 1}`;
      const order = { id, tenantId: input.tenantId, state: 'APPROVED', sagaId: `saga-${id}` };
      orders.set(id, order);
      const reserve: SagaStep<object, number> = {
        name: 'reserve', execute: async () => { reservedQuantity += input.quantity; return input.quantity; },
        compensate: async (_context, quantity) => { reservedQuantity -= quantity; },
      };
      const payment: SagaStep<object> = {
        name: 'payment', execute: async () => {
          if (input.payment.id.includes('fail')) throw new Error('payment declined');
        }, compensate: async () => undefined,
      };
      const accepted = { ...order };
      try { await new FulfillmentSaga([reserve, payment]).execute({}); }
      catch { order.state = 'FAILED'; }
      if (order.state !== 'FAILED') order.state = 'CONFIRMED';
      return accepted;
    }),
    getOrder: vi.fn(async (_tenantId: string, id: string) => {
      const order = orders.get(id);
      if (!order) throw new Error('Order not found');
      return order;
    }),
    cancelOrder: vi.fn(async (_tenantId: string, id: string) => ({ id, state: 'CANCELLED' })),
  };

  beforeEach(async () => {
    orders.clear();
    reservedQuantity = 0;
    process.env.AUTH_JWT_SECRET = testJwtSecret;
    const moduleFixture = await Test.createTestingModule({
      imports: [TenantModule],
      controllers: [OrdersController],
      providers: [{ provide: FulfillmentSagaService, useValue: service }],
    })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterEach(async () => { await app?.close(); });

  it('creates an order and reports successful fulfillment', async () => {
    const created = await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${tenantToken}`).set('X-Tenant-Id', 'tenant-1').set('Idempotency-Key', 'happy-1')
      .send({ inventoryItemId: 'sku-1', quantity: 1, payment: { id: 'payment-1', lines: [] } })
      .expect(202);
    expect(created.body.state).toBe('APPROVED');
    await request(app.getHttpServer()).get(`/orders/${created.body.id}`).set('Authorization', `Bearer ${tenantToken}`).expect(200).expect(({ body }) => {
      expect(body.state).toBe('CONFIRMED');
    });
  });

  it('requires authentication and rejects tenant selection outside signed memberships', async () => {
    await request(app.getHttpServer()).post('/orders').set('Idempotency-Key', 'unauthenticated')
      .send({ inventoryItemId: 'sku-1', quantity: 1, payment: { id: 'payment-unauthenticated', lines: [] } })
      .expect(401);

    await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${tenantToken}`)
      .set('X-Tenant-Id', 'tenant-2').set('Idempotency-Key', 'wrong-tenant')
      .send({ inventoryItemId: 'sku-1', quantity: 1, payment: { id: 'payment-wrong-tenant', lines: [] } })
      .expect(403);
  });

  it('uses one token to act in each tenant listed in its signed membership claim', async () => {
    for (const tenantId of ['tenant-1', 'tenant-2']) {
      const response = await request(app.getHttpServer()).post('/orders')
        .set('Authorization', `Bearer ${multiTenantToken}`).set('X-Tenant-Id', tenantId)
        .set('Idempotency-Key', `multi-${tenantId}`)
        .send({ inventoryItemId: 'sku-1', quantity: 1, payment: { id: `payment-${tenantId}`, lines: [] } })
        .expect(202);
      expect(response.body.tenantId).toBe(tenantId);
    }

    await request(app.getHttpServer()).post('/orders')
      .set('Authorization', `Bearer ${multiTenantToken}`).set('X-Tenant-Id', 'tenant-3')
      .set('Idempotency-Key', 'multi-tenant-3')
      .send({ inventoryItemId: 'sku-1', quantity: 1, payment: { id: 'payment-tenant-3', lines: [] } })
      .expect(403);
  });

  it('exposes the failed state after payment failure rollback', async () => {
    const created = await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${tenantToken}`).set('Idempotency-Key', 'fail-1')
      .send({ inventoryItemId: 'sku-1', quantity: 1, payment: { id: 'payment-fail', lines: [] } })
      .expect(202);
    await request(app.getHttpServer()).get(`/orders/${created.body.id}`).set('Authorization', `Bearer ${tenantToken}`).expect(200).expect(({ body }) => {
      expect(body.state).toBe('FAILED');
    });
    expect(reservedQuantity).toBe(0);
  });
});

function createTenantToken(tenant: string | string[]): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const tenantClaims = Array.isArray(tenant) ? { tenant_ids: tenant } : { tenant_id: tenant };
  const payload = Buffer.from(JSON.stringify({ sub: 'e2e-user', ...tenantClaims, exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
  const signature = createHmac('sha256', testJwtSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}
