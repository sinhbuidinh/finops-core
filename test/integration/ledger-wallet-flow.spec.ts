import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { LedgerController } from '../../src/modules/ledger/ledger.controller.js';
import { LedgerService } from '../../src/modules/ledger/ledger.service.js';
import { PostJournalEntryUseCase } from '../../src/modules/ledger/application/post-journal-entry.use-case.js';
import { ReverseJournalEntryUseCase } from '../../src/modules/ledger/application/reverse-journal-entry.use-case.js';
import { PostgresLedgerEntryRepository } from '../../src/modules/ledger/infrastructure/postgres-ledger-entry.repository.js';
import { describeWithTestDatabase, testDatabaseUrl } from '../helpers/test-database.js';

describeWithTestDatabase('ledger wallet funding integration', () => {
  const schema = `ledger_wallet_it_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let pool: Pool;
  let controller: LedgerController;
  const walletAccountId = `wallet-${randomUUID()}`;
  const fundingAccountId = `funding-${randomUUID()}`;

  beforeAll(async () => {
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schema}` });
    for (const migration of ['001_reliability_tables.sql', '002_ledger.sql', '012_ledger_account_balances.sql', '013_tenant_wallet_ledger.sql']) {
      const sql = readFileSync(join(process.cwd(), 'src/shared/infrastructure/database/migrations', migration), 'utf8');
      await pool.query(sql);
    }

    const repository = new PostgresLedgerEntryRepository(pool);
    const service = new LedgerService(
      new PostJournalEntryUseCase(repository),
      new ReverseJournalEntryUseCase(repository),
      repository,
    );
    controller = new LedgerController(service);
    await pool.query(
      `INSERT INTO ledger_accounts (account_id, name, type, tenant_id) VALUES ($1, 'Integration wallet', 'ASSET', 'tenant-wallet-it'), ($2, 'Funding clearing', 'ASSET', 'tenant-wallet-it')`,
      [walletAccountId, fundingAccountId],
    );
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminPool.end();
  });

  it('posts funds into one account and returns its persisted balance', async () => {
    const fundingEntry = {
      id: `fund-${randomUUID()}`,
      description: 'Integration wallet funding',
      lines: [
        { accountId: walletAccountId, side: 'DEBIT', amount: { minorUnits: '7500', currency: 'USD' } },
        { accountId: fundingAccountId, side: 'CREDIT', amount: { minorUnits: '7500', currency: 'USD' } },
      ],
    };
    const idempotencyKey = `wallet-funding-${randomUUID()}`;

    const posted = await controller.postEntry('tenant-wallet-it', fundingEntry, idempotencyKey);
    const replayed = await controller.postEntry('tenant-wallet-it', fundingEntry, idempotencyKey);
    expect(replayed).toEqual(posted);
    await expect(controller.getBalance('tenant-wallet-it', walletAccountId)).resolves.toEqual([{
      accountId: walletAccountId,
      accountName: 'Integration wallet',
      accountType: 'ASSET',
      currency: 'USD',
      balanceMinorUnits: '7500',
    }]);
    await expect(controller.getBalance('tenant-wallet-it', fundingAccountId)).resolves.toMatchObject([{ balanceMinorUnits: '-7500', currency: 'USD' }]);
    await expect(controller.getBalance('tenant-other', walletAccountId)).rejects.toThrow();
    await expect(controller.postEntry('tenant-other', fundingEntry, `cross-tenant-${randomUUID()}`)).rejects.toThrow();

    const count = await pool.query('SELECT count(*)::int AS count FROM journal_entries WHERE entry_id = $1', [fundingEntry.id]);
    expect(count.rows[0]?.count).toBe(1);
  });

  it('rejects wallet spending beyond the persisted balance without writing a journal entry', async () => {
    const wallet = await controller.createWallet('tenant-wallet-it', { walletId: `spend-${randomUUID()}`, name: 'Spend test wallet' });
    const walletLedgerId = `wallet-account:${wallet.walletId}`;
    const fundId = `fund-${randomUUID()}`;
    await controller.postEntry('tenant-wallet-it', {
      id: fundId, description: 'Wallet funding',
      lines: [
        { accountId: walletLedgerId, side: 'DEBIT', amount: { minorUnits: '1000', currency: 'USD' } },
        { accountId: fundingAccountId, side: 'CREDIT', amount: { minorUnits: '1000', currency: 'USD' } },
      ],
    }, `fund-${randomUUID()}`);

    await expect(controller.postEntry('tenant-wallet-it', {
      id: `spend-${randomUUID()}`, description: 'Overspend',
      lines: [
        { accountId: fundingAccountId, side: 'DEBIT', amount: { minorUnits: '1001', currency: 'USD' } },
        { accountId: walletLedgerId, side: 'CREDIT', amount: { minorUnits: '1001', currency: 'USD' } },
      ],
    }, `spend-${randomUUID()}`)).rejects.toMatchObject({ code: 'INSUFFICIENT_WALLET_BALANCE' });
    await expect(controller.getBalance('tenant-wallet-it', walletLedgerId)).resolves.toMatchObject([{ balanceMinorUnits: '1000' }]);
  });

  it('serializes concurrent wallet spends so only one can consume the available balance', async () => {
    const wallet = await controller.createWallet('tenant-wallet-it', { walletId: `race-${randomUUID()}`, name: 'Race test wallet' });
    const walletLedgerId = `wallet-account:${wallet.walletId}`;
    await controller.postEntry('tenant-wallet-it', {
      id: `fund-${randomUUID()}`, description: 'Wallet funding',
      lines: [
        { accountId: walletLedgerId, side: 'DEBIT', amount: { minorUnits: '700', currency: 'USD' } },
        { accountId: fundingAccountId, side: 'CREDIT', amount: { minorUnits: '700', currency: 'USD' } },
      ],
    }, `fund-${randomUUID()}`);
    const attempt = () => controller.postEntry('tenant-wallet-it', {
      id: `spend-${randomUUID()}`, description: 'Concurrent spend',
      lines: [
        { accountId: fundingAccountId, side: 'DEBIT', amount: { minorUnits: '500', currency: 'USD' } },
        { accountId: walletLedgerId, side: 'CREDIT', amount: { minorUnits: '500', currency: 'USD' } },
      ],
    }, `spend-${randomUUID()}`);
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(controller.getBalance('tenant-wallet-it', walletLedgerId)).resolves.toMatchObject([{ balanceMinorUnits: '200' }]);
  });

  it('maps wallets to same-tenant ledger accounts and hides another tenant balance', async () => {
    const repository = new PostgresLedgerEntryRepository(pool);
    const wallet = await repository.createWallet({ walletId: `wallet-${randomUUID()}`, tenantId: 'tenant-a', name: 'Tenant A wallet' });
    await expect(repository.findWallet(wallet.walletId, 'tenant-a')).resolves.toEqual({ walletId: wallet.walletId, ledgerAccountId: wallet.ledgerAccountId });
    await expect(repository.findWallet(wallet.walletId, 'tenant-b')).resolves.toBeNull();
    await expect(repository.getBalance(wallet.ledgerAccountId, 'tenant-b')).rejects.toThrow();
    await expect(pool.query(`INSERT INTO wallets (wallet_id, tenant_id, ledger_account_id) VALUES ($1, $2, $3)`, [`bad-${randomUUID()}`, 'tenant-b', wallet.ledgerAccountId])).rejects.toMatchObject({ code: '23514' });
  });
});
