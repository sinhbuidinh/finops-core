import type { Pool, PoolClient } from 'pg';
import { Money } from '../../../shared/domain/money.js';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { JOURNAL_SIDES, JournalEntry } from '../domain/journal-entry.js';
import { PostgresLedgerEntryRepository } from './postgres-ledger-entry.repository.js';

function makeEntry() {
  return JournalEntry.create({
    id: 'entry-1',
    description: 'Sale',
    lines: [
      { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: Money.fromMinorUnits(25n, 'USD') },
      { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: Money.fromMinorUnits(25n, 'USD') },
    ],
  });
}

describe('PostgresLedgerEntryRepository', () => {
  it('persists an entry and all its lines in one transaction', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const repository = new PostgresLedgerEntryRepository(pool);

    const result = await repository.save(makeEntry());

    expect(result.id).toBe('entry-1');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringContaining('INSERT INTO journal_entries'),
      expect.stringContaining('INSERT INTO journal_entry_lines'),
      expect.stringContaining('INSERT INTO journal_entry_lines'),
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledOnce();
  });

  it('commits the idempotency result with the journal insert and lines', async () => {
    const context = { scope: 'ledger:post', key: 'key-1', fingerprint: 'fingerprint' };
    let claimedToken: unknown;
    const query = vi.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.includes('INSERT INTO idempotency_keys')) claimedToken = values[3];
      if (sql.includes('SELECT fingerprint, state, response_body')) {
        return { rowCount: 1, rows: [{ fingerprint: context.fingerprint, state: 'IN_PROGRESS', response_body: null, owner_token: claimedToken }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const repository = new PostgresLedgerEntryRepository(pool);

    await repository.save(makeEntry(), context);

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements[0]).toBe('BEGIN');
    expect(statements.some((sql) => sql.includes('INSERT INTO idempotency_keys'))).toBe(true);
    expect(statements.some((sql) => sql.includes('UPDATE idempotency_keys'))).toBe(true);
    expect(statements.at(-1)).toBe('COMMIT');
  });

  it('persists reversal headers with the original entry reference', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const repository = new PostgresLedgerEntryRepository({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    const reversal = JournalEntry.reversalOf('entry-2', makeEntry());

    await repository.saveReversal('entry-1', reversal);
    const header = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO journal_entries'));
    expect(header?.[1]).toEqual(['entry-2', expect.any(String), reversal.postedAt, 'entry-1']);
  });

  it('rolls back when an insert fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO journal_entry_lines')) throw new Error('database unavailable');
      return { rowCount: 1, rows: [] };
    });
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const repository = new PostgresLedgerEntryRepository(pool);

    await expect(repository.save(makeEntry())).rejects.toThrow('database unavailable');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('preserves the original error when rollback also fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO journal_entries')) throw new Error('insert failed');
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rowCount: 1, rows: [] };
    });
    const repository = new PostgresLedgerEntryRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool);
    await expect(repository.save(makeEntry())).rejects.toThrow('insert failed');
  });

  it('maps persisted entries and returns null when an entry is absent', async () => {
    const row = {
      entry_id: 'entry-1', description: 'Sale', posted_at: new Date('2026-01-01T00:00:00.000Z'),
      reversal_of_entry_id: null,
      lines: [
        { account_id: 'cash', side: 'DEBIT', amount_minor: '25', currency: 'USD', memo: null },
        { account_id: 'revenue', side: 'CREDIT', amount_minor: '25', currency: 'USD', memo: 'sale' },
      ],
    } as const;
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [row] });
    const repository = new PostgresLedgerEntryRepository({ query } as unknown as Pool);

    expect(await repository.findById('missing')).toBeNull();
    const entry = await repository.findById('entry-1');
    expect(entry?.lines[0]?.amount.minorUnits).toBe(25n);
    expect(entry?.lines[1]?.memo).toBe('sale');
  });

  it('maps reversal lookups and all idempotency lookup outcomes', async () => {
    const savedEntry = {
      id: 'entry-1', description: 'Sale', postedAt: '2026-01-01T00:00:00.000Z',
      lines: [
        { accountId: 'cash', side: 'DEBIT', amount: { minorUnits: '25', currency: 'USD' } },
        { accountId: 'revenue', side: 'CREDIT', amount: { minorUnits: '25', currency: 'USD' } },
      ],
    };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ entry_id: 'reverse-1', description: 'Reverse', posted_at: new Date(), reversal_of_entry_id: 'entry-1', lines: [
        { account_id: 'cash', side: 'CREDIT', amount_minor: '25', currency: 'USD', memo: null },
        { account_id: 'revenue', side: 'DEBIT', amount_minor: '25', currency: 'USD', memo: null },
      ] }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ fingerprint: 'different', state: 'COMPLETED' }] })
      .mockResolvedValueOnce({ rows: [{ fingerprint: 'fingerprint', state: 'IN_PROGRESS' }] })
      .mockResolvedValueOnce({ rows: [{ fingerprint: 'fingerprint', state: 'COMPLETED', response_body: savedEntry }] });
    const repository = new PostgresLedgerEntryRepository({ query } as unknown as Pool);
    const context = { scope: 'ledger:post', key: 'key', fingerprint: 'fingerprint' };

    expect((await repository.findReversalOf('entry-1'))?.reversalOfEntryId).toBe('entry-1');
    expect(await repository.findReversalOf('not-reversed')).toBeNull();
    expect(await repository.findIdempotentResult(context)).toBeNull();
    await expect(repository.findIdempotentResult(context)).rejects.toThrow(DomainConflictError);
    await expect(repository.findIdempotentResult(context)).rejects.toThrow('already in progress');
    expect((await repository.findIdempotentResult(context))?.id).toBe('entry-1');
  });

  it('maps balance results, defaults missing totals to zero, and reports unknown accounts', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ account_id: 'cash', name: 'Cash', type: 'ASSET', currency: null, balance_minor_units: null }] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });
    const repository = new PostgresLedgerEntryRepository({ query } as unknown as Pool);
    expect(await repository.getBalance('cash')).toEqual([{
      accountId: 'cash', accountName: 'Cash', accountType: 'ASSET', currency: null, balanceMinorUnits: '0',
    }]);
    await expect(repository.getBalance('missing')).rejects.toThrow(DomainNotFoundError);
  });

  it('reads history with and without a cursor', async () => {
    const historyRow = {
      entry_id: 'entry-1', description: 'Sale', posted_at: new Date('2026-01-01T00:00:00.000Z'),
      reversal_of_entry_id: null,
      lines: [
        { account_id: 'cash', side: 'DEBIT', amount_minor: '25', currency: 'USD', memo: null },
        { account_id: 'revenue', side: 'CREDIT', amount_minor: '25', currency: 'USD', memo: null },
      ],
    };
    const query = vi.fn().mockResolvedValueOnce({ rows: [historyRow] }).mockResolvedValueOnce({ rows: [historyRow] });
    const repository = new PostgresLedgerEntryRepository({ query } as unknown as Pool);
    expect((await repository.getHistory({ limit: 10 }))[0]?.id).toBe('entry-1');
    expect((await repository.getHistory({ limit: 10, after: { id: 'entry-1', postedAt: new Date('2026-01-01T00:00:00.000Z') } }))[0]?.id).toBe('entry-1');
    expect(query.mock.calls[0]?.[0]).toContain('ORDER BY entry.posted_at DESC');
    expect(query.mock.calls[1]?.[0]).toContain('(entry.posted_at, entry.entry_id) < ($1, $2)');
  });

  it('replays completed posting transactions without inserting duplicate entries', async () => {
    const stored = {
      id: 'entry-1', description: 'Sale', postedAt: '2026-01-01T00:00:00.000Z',
      lines: [
        { accountId: 'cash', side: 'DEBIT', amount: { minorUnits: '25', currency: 'USD' } },
        { accountId: 'revenue', side: 'CREDIT', amount: { minorUnits: '25', currency: 'USD' } },
      ],
    };
    const query = vi.fn(async (sql: string) => sql.includes('SELECT fingerprint, state, response_body')
      ? { rows: [{ fingerprint: 'fingerprint', state: 'COMPLETED', response_body: stored, owner_token: null }] }
      : { rows: [], rowCount: 1 });
    const pool = { connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }) } as unknown as Pool;
    const repository = new PostgresLedgerEntryRepository(pool);

    expect((await repository.save(makeEntry(), { scope: 'ledger:post', key: 'key', fingerprint: 'fingerprint' })).id).toBe('entry-1');
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO journal_entries'))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
  });

  it.each([
    ['different fingerprint', { fingerprint: 'other', state: 'IN_PROGRESS', owner_token: 'owner' }, 'different request'],
    ['another active request', { fingerprint: 'fingerprint', state: 'IN_PROGRESS', owner_token: 'other-owner' }, 'already in progress'],
  ])('rejects idempotency claim when there is %s', async (_label, record, message) => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT fingerprint, state, response_body')
      ? { rows: [record] }
      : { rows: [], rowCount: 1 });
    const repository = new PostgresLedgerEntryRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool);
    await expect(repository.save(makeEntry(), { scope: 'ledger:post', key: 'key', fingerprint: 'fingerprint' }))
      .rejects.toThrow(message);
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it('fails and rolls back if the idempotency row disappears after claiming it', async () => {
    const query = vi.fn(async (sql: string) => sql.includes('SELECT fingerprint, state, response_body')
      ? { rows: [] }
      : { rows: [], rowCount: 1 });
    const repository = new PostgresLedgerEntryRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool);
    await expect(repository.save(makeEntry(), { scope: 'ledger:post', key: 'key', fingerprint: 'fingerprint' }))
      .rejects.toThrow('Idempotency record disappeared');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });

  it.each([
    ['23505', DomainConflictError],
    ['23503', DomainNotFoundError],
    ['23514', DomainValidationError],
    ['55000', DomainConflictError],
  ])('maps PostgreSQL error %s to a domain error', async (code, ErrorType) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO journal_entries')) throw Object.assign(new Error('db error'), { code });
      return { rowCount: 1, rows: [] };
    });
    const repository = new PostgresLedgerEntryRepository({
      connect: vi.fn().mockResolvedValue({ query, release: vi.fn() }),
    } as unknown as Pool);
    await expect(repository.save(makeEntry())).rejects.toBeInstanceOf(ErrorType);
  });
});
