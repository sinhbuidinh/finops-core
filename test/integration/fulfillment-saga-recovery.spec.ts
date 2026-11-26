import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { FulfillmentSaga } from '../../src/modules/fulfillment-saga/application/fulfillment-saga.js';
import { ReserveInventoryStep, SettleLedgerPaymentStep } from '../../src/modules/fulfillment-saga/application/saga-steps.js';
import { LedgerPostingAdapter } from '../../src/modules/fulfillment-saga/infrastructure/ledger-posting.adapter.js';
import { FulfillmentSagaWorker } from '../../src/modules/fulfillment-saga/infrastructure/fulfillment-saga.worker.js';
import { InventoryService } from '../../src/modules/inventory/inventory.service.js';
import { PostgresInventoryRepository } from '../../src/modules/inventory/infrastructure/postgres-inventory.repository.js';
import { LedgerService } from '../../src/modules/ledger/ledger.service.js';
import { PostJournalEntryUseCase } from '../../src/modules/ledger/application/post-journal-entry.use-case.js';
import { ReverseJournalEntryUseCase } from '../../src/modules/ledger/application/reverse-journal-entry.use-case.js';
import { PostgresLedgerEntryRepository } from '../../src/modules/ledger/infrastructure/postgres-ledger-entry.repository.js';

if (!process.env.INVENTORY_TEST_DATABASE_URL && existsSync('.env')) process.loadEnvFile('.env');
const connectionString = process.env.INVENTORY_TEST_DATABASE_URL;
const integration = connectionString ? describe : describe.skip;

integration('fulfillment saga PostgreSQL recovery', () => {
  const pool = new Pool({ connectionString, max: 5 });
  const inventory = new InventoryService(new PostgresInventoryRepository(pool));
  const ledgerRepository = new PostgresLedgerEntryRepository(pool);
  const ledger = new LedgerService(
    new PostJournalEntryUseCase(ledgerRepository),
    new ReverseJournalEntryUseCase(ledgerRepository),
    ledgerRepository,
  );
  const adapter = new LedgerPostingAdapter(ledger);
  const prefix = `saga-it-${randomUUID()}`;
  const sagaId = randomUUID();
  const orderId = randomUUID();
  const entryId = `${prefix}-entry`;
  let worker!: FulfillmentSagaWorker;

  beforeAll(async () => {
    for (const migration of [
      '001_reliability_tables.sql', '002_ledger.sql', '003_inventory.sql',
      '004_fulfillment_saga.sql', '005_fulfillment_orders.sql', '006_idempotent_stock_reservations.sql',
    ]) {
      await pool.query(readFileSync(join(process.cwd(), 'src/shared/infrastructure/database/migrations', migration), 'utf8'));
    }
    await pool.query(`INSERT INTO ledger_accounts (account_id, name, type) VALUES ($1, 'Saga cash', 'ASSET'), ($2, 'Saga revenue', 'REVENUE')`, [`${prefix}-cash`, `${prefix}-revenue`]);
    await inventory.createItem({ id: `${prefix}-sku`, totalQty: 4 });
    const saga = new FulfillmentSaga([
      new ReserveInventoryStep(inventory),
      new SettleLedgerPaymentStep({
        post: async (...args: Parameters<LedgerPostingAdapter['post']>) => {
          const posted = await adapter.post(...args);
          if (loseFirstResponse) {
            loseFirstResponse = false;
            throw new Error('ledger response lost after commit');
          }
          return posted;
        },
        reverse: adapter.reverse.bind(adapter),
      }),
    ]);
    worker = new FulfillmentSagaWorker(pool, saga);
  });

  let loseFirstResponse = true;

  afterAll(async () => {
    await pool.query('DELETE FROM stock_reservations WHERE item_id = $1', [`${prefix}-sku`]);
    await pool.query('DELETE FROM inventory_items WHERE item_id = $1', [`${prefix}-sku`]);
    await pool.query('DELETE FROM outbox_events WHERE aggregate_id = $1', [orderId]);
    await pool.query('DELETE FROM fulfillment_orders WHERE id = $1', [orderId]);
    await pool.query('DELETE FROM fulfillment_saga_jobs WHERE saga_id = $1', [sagaId]);
    await pool.query('DELETE FROM idempotency_keys WHERE key LIKE $1', [`%${prefix}%`]);
    await pool.end();
  });

  it('recovers a lost ledger response without duplicating stock or journal entries', async () => {
    const payload = {
      sagaId, orderId, inventoryItemId: `${prefix}-sku`, quantity: 2,
      payment: {
        id: entryId, description: 'Integration order payment', postedAt: new Date().toISOString(),
        lines: [
          { accountId: `${prefix}-cash`, side: 'DEBIT' as const, amount: { minorUnits: '500', currency: 'USD' } },
          { accountId: `${prefix}-revenue`, side: 'CREDIT' as const, amount: { minorUnits: '500', currency: 'USD' } },
        ],
      },
    };
    await pool.query('INSERT INTO fulfillment_saga_jobs (saga_id, order_id, payload) VALUES ($1, $2, $3)', [sagaId, orderId, payload]);
    await pool.query(`INSERT INTO fulfillment_orders (id, tenant_id, state, saga_id, payload) VALUES ($1, $2, 'APPROVED', $3, $4)`, [orderId, prefix, sagaId, payload]);

    await worker.runOnce();
    await expect(inventory.getItem(`${prefix}-sku`)).resolves.toMatchObject({ reservedQty: 0, availableQty: 4 });
    const retry = await pool.query(`UPDATE fulfillment_saga_jobs SET available_at = now() WHERE saga_id = $1 RETURNING state`, [sagaId]);
    expect(retry.rows[0]?.state).toBe('PENDING');
    await worker.runOnce();
    await expect(inventory.getItem(`${prefix}-sku`)).resolves.toMatchObject({ reservedQty: 2, availableQty: 2 });
    await expect(ledgerRepository.findById(entryId)).resolves.toMatchObject({ id: entryId });
    const entryCount = await pool.query('SELECT count(*)::int AS count FROM journal_entries WHERE entry_id = $1', [entryId]);
    expect(entryCount.rows[0]?.count).toBe(1);
    const order = await pool.query('SELECT state FROM fulfillment_orders WHERE id = $1', [orderId]);
    expect(order.rows[0]?.state).toBe('CONFIRMED');
  });
});
