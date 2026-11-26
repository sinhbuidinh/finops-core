import type { Pool, PoolClient } from 'pg';
import { Money } from '../../../shared/domain/money.js';
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

  it('rolls back when an insert fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO journal_entry_lines')) throw new Error('database unavailable');
      return { rowCount: 1, rows: [] };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
    const repository = new PostgresLedgerEntryRepository(pool);

    await expect(repository.save(makeEntry())).rejects.toThrow('database unavailable');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
