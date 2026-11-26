import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  const itemId = `concurrency-${randomUUID()}`;

  beforeAll(async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS inventory_items (
        item_id TEXT PRIMARY KEY,
        total_qty INTEGER NOT NULL CHECK (total_qty >= 0),
        reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0 AND reserved_qty <= total_qty),
        available_qty INTEGER GENERATED ALWAYS AS (total_qty - reserved_qty) STORED,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS stock_reservations (
        reservation_id UUID PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), released_at TIMESTAMPTZ,
        CHECK ((status = 'ACTIVE' AND released_at IS NULL) OR (status = 'RELEASED' AND released_at IS NOT NULL))
      );`);
    await repository.createItem(InventoryItem.create({ id: itemId, totalQty: 7 }));
  });

  afterAll(async () => {
    await pool.query('DELETE FROM stock_reservations WHERE item_id = $1', [itemId]);
    await pool.query('DELETE FROM inventory_items WHERE item_id = $1', [itemId]);
    await pool.end();
  });

  it('does not oversell when simultaneous reservations compete for the last units', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 24 }, () => repository.reserve(itemId, 1)));
    const successes = outcomes.filter((result) => result.status === 'fulfilled');
    const conflicts = outcomes.filter((result) => result.status === 'rejected' && result.reason instanceof DomainConflictError);

    expect(successes).toHaveLength(7);
    expect(conflicts).toHaveLength(17);
    const item = await repository.findItem(itemId);
    expect(item).toMatchObject({ totalQty: 7, reservedQty: 7, availableQty: 0 });

    const reservationIds = successes.map((result) => result.status === 'fulfilled' ? result.value.id : '');
    await Promise.all(reservationIds.map((id) => repository.release(id)));
    expect(await repository.findItem(itemId)).toMatchObject({ totalQty: 7, reservedQty: 0, availableQty: 7 });
  });
});
