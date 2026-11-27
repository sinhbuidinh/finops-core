import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { DomainConflictError } from '../../src/shared/domain/domain-error.js';
import { InventoryItem } from '../../src/modules/inventory/domain/inventory-item.js';
import { PostgresInventoryRepository } from '../../src/modules/inventory/infrastructure/postgres-inventory.repository.js';

if (!process.env.INVENTORY_TEST_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const connectionString = process.env.INVENTORY_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;
const testDatabaseUrl = connectionString ? new URL(connectionString) : undefined;
// docker-compose sets DB_HOST=postgres for the API container. There, loopback
// refers to the API container rather than PostgreSQL; use the compose service DNS.
if (testDatabaseUrl && process.env.DB_HOST === 'postgres') testDatabaseUrl.hostname = 'postgres';

integration('inventory PostgreSQL concurrency', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl?.toString(), max: 20 });
  const repository = new PostgresInventoryRepository(pool);
  const tenantId = `tenant-${randomUUID()}`;
  const otherTenantId = `tenant-${randomUUID()}`;
  const itemId = `concurrency-${randomUUID()}`;

  beforeAll(async () => {
    for (const migration of ['003_inventory.sql', '006_idempotent_stock_reservations.sql', '007_tenant_scoped_inventory.sql']) {
      await pool.query(readFileSync(join(process.cwd(), 'src/shared/infrastructure/database/migrations', migration), 'utf8'));
    }
    await repository.createItem(InventoryItem.create({ tenantId, id: itemId, totalQty: 7 }));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM stock_reservations WHERE tenant_id = $1 AND item_id = $2', [tenantId, itemId]);
    await pool.query('DELETE FROM inventory_items WHERE tenant_id = $1 AND item_id = $2', [tenantId, itemId]);
    await pool.end();
  });

  it('does not oversell when simultaneous reservations compete for the last units', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 24 }, () => repository.reserve(tenantId, itemId, 1)));
    const successes = outcomes.filter((result) => result.status === 'fulfilled');
    const conflicts = outcomes.filter((result) => result.status === 'rejected' && result.reason instanceof DomainConflictError);

    expect(successes).toHaveLength(7);
    expect(conflicts).toHaveLength(17);
    const item = await repository.findItem(tenantId, itemId);
    expect(item).toMatchObject({ totalQty: 7, reservedQty: 7, availableQty: 0 });

    const reservationIds = successes.map((result) => result.status === 'fulfilled' ? result.value.id : '');
    await Promise.all(reservationIds.map((id) => repository.release(tenantId, id)));
    expect(await repository.findItem(tenantId, itemId)).toMatchObject({ totalQty: 7, reservedQty: 0, availableQty: 7 });
  });

  it('isolates matching SKU IDs and reservations between tenants', async () => {
    const sharedSku = `shared-${randomUUID()}`;
    await repository.createItem(InventoryItem.create({ tenantId, id: sharedSku, totalQty: 3 }));
    await repository.createItem(InventoryItem.create({ tenantId: otherTenantId, id: sharedSku, totalQty: 8 }));

    const reservation = await repository.reserve(tenantId, sharedSku, 2, 'same-key');
    expect(await repository.findItem(tenantId, sharedSku)).toMatchObject({ reservedQty: 2, availableQty: 1 });
    expect(await repository.findItem(otherTenantId, sharedSku)).toMatchObject({ reservedQty: 0, availableQty: 8 });
    await expect(repository.reserve(otherTenantId, 'missing-for-this-tenant', 1)).rejects.toThrow('Inventory item not found');

    await repository.release(tenantId, reservation.id);
    await pool.query('DELETE FROM stock_reservations WHERE tenant_id = $1 AND reservation_id = $2', [tenantId, reservation.id]);
    await pool.query('DELETE FROM inventory_items WHERE tenant_id = $1 AND item_id = $2', [tenantId, sharedSku]);
    await pool.query('DELETE FROM inventory_items WHERE tenant_id = $1 AND item_id = $2', [otherTenantId, sharedSku]);
  });
});
