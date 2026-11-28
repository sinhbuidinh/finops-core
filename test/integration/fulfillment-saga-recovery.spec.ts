import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import { describeWithTestDatabase, testDatabaseUrl } from '../helpers/test-database.js';

describeWithTestDatabase('fulfillment saga PostgreSQL recovery', () => {
  const pool = new Pool({ connectionString: testDatabaseUrl, max: 5 });
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
      '004_fulfillment_saga.sql', '005_fulfillment_orders.sql', '006_idempotent_stock_reservations.sql', '007_tenant_scoped_inventory.sql', '012_ledger_account_balances.sql', '013_tenant_wallet_ledger.sql',
    ]) {
      await pool.query(readFileSync(join(process.cwd(), 'src/shared/infrastructure/database/migrations', migration), 'utf8'));
    }
    const wallet = await ledgerRepository.createWallet({ walletId: `${prefix}-wallet`, tenantId: prefix, name: 'Saga wallet' });
    await pool.query(
      'INSERT INTO ledger_account_balances (account_id, currency, balance_minor_units) VALUES ($1, $2, $3)',
      [wallet.ledgerAccountId, 'USD', '500'],
    );
    await inventory.createItem({ tenantId: prefix, id: `${prefix}-sku`, totalQty: 4 });
    const saga = new FulfillmentSaga([
      new ReserveInventoryStep(inventory),
      new SettleLedgerPaymentStep({
        postWalletPayment: async (...args: Parameters<LedgerPostingAdapter['postWalletPayment']>) => {
          const posted = await adapter.postWalletPayment(...args);
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
      sagaId, orderId, tenantId: prefix, inventoryItemId: `${prefix}-sku`, quantity: 2,
      payment: {
        id: entryId, description: 'Integration order payment', postedAt: new Date().toISOString(),
        walletId: `${prefix}-wallet`, amount: { minorUnits: '500', currency: 'USD' },
      },
    };
    await pool.query('INSERT INTO fulfillment_saga_jobs (saga_id, order_id, payload) VALUES ($1, $2, $3)', [sagaId, orderId, payload]);
    await pool.query(`INSERT INTO fulfillment_orders (id, tenant_id, state, saga_id, payload) VALUES ($1, $2, 'APPROVED', $3, $4)`, [orderId, prefix, sagaId, payload]);

    await worker.runOnce();
    await expect(inventory.getItem(prefix, `${prefix}-sku`)).resolves.toMatchObject({ reservedQty: 0, availableQty: 4 });
    const retry = await pool.query(`UPDATE fulfillment_saga_jobs SET available_at = now() WHERE saga_id = $1 RETURNING state`, [sagaId]);
    expect(retry.rows[0]?.state).toBe('PENDING');
    await worker.runOnce();
    await expect(inventory.getItem(prefix, `${prefix}-sku`)).resolves.toMatchObject({ reservedQty: 2, availableQty: 2 });
    await expect(ledgerRepository.findById(entryId)).resolves.toMatchObject({ id: entryId });
    const entryCount = await pool.query('SELECT count(*)::int AS count FROM journal_entries WHERE entry_id = $1', [entryId]);
    expect(entryCount.rows[0]?.count).toBe(1);
    const order = await pool.query('SELECT state FROM fulfillment_orders WHERE id = $1', [orderId]);
    expect(order.rows[0]?.state).toBe('CONFIRMED');
  });
});
