import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { Money } from '../../../shared/domain/money.js';
import { POSTGRES_POOL } from '../../../shared/infrastructure/database/database.module.js';
import type { Pool, PoolClient } from 'pg';
import { JournalEntry } from '../domain/journal-entry.js';
import type { JournalLine } from '../domain/journal-entry.js';
import type { LedgerEntryRepositoryPort, LedgerIdempotencyContext } from '../application/ledger-entry-repository.port.js';

interface EntryRow {
  entry_id: string;
  description: string;
  posted_at: Date;
  reversal_of_entry_id: string | null;
  lines: Array<{ account_id: string; side: 'DEBIT' | 'CREDIT'; amount_minor: string; currency: string; memo: string | null }>;
}

export interface LedgerAccountBalance {
  readonly accountId: string;
  readonly accountName: string;
  readonly accountType: string;
  readonly currency: string | null;
  /** Signed normal balance in minor units. */
  readonly balanceMinorUnits: string;
}

@Injectable()
export class PostgresLedgerEntryRepository implements LedgerEntryRepositoryPort {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  save(entry: JournalEntry, idempotency?: LedgerIdempotencyContext): Promise<JournalEntry> {
    return this.persist(entry, undefined, idempotency);
  }

  saveReversal(originalEntryId: string, reversal: JournalEntry, idempotency?: LedgerIdempotencyContext): Promise<JournalEntry> {
    return this.persist(reversal, originalEntryId, idempotency);
  }

  async findById(id: string): Promise<JournalEntry | null> {
    const result = await this.pool.query<EntryRow>(`${ENTRY_SELECT} WHERE entry.entry_id = $1`, [id]);
    return result.rows[0] ? this.toDomain(result.rows[0]) : null;
  }

  async findReversalOf(originalEntryId: string): Promise<JournalEntry | null> {
    const result = await this.pool.query<EntryRow>(`${ENTRY_SELECT} WHERE entry.reversal_of_entry_id = $1`, [originalEntryId]);
    return result.rows[0] ? this.toDomain(result.rows[0]) : null;
  }

  async findIdempotentResult(context: LedgerIdempotencyContext): Promise<JournalEntry | null> {
    const result = await this.pool.query<{
      fingerprint: string; state: 'IN_PROGRESS' | 'COMPLETED'; response_body: unknown; expires_at: Date;
    }>(
      `SELECT fingerprint, state, response_body, expires_at FROM idempotency_keys
        WHERE scope = $1 AND key = $2 AND expires_at > now()`,
      [context.scope, context.key],
    );
    const record = result.rows[0];
    if (!record) return null;
    if (record.fingerprint !== context.fingerprint) {
      throw new DomainConflictError('Idempotency key was used with a different request', 'IDEMPOTENCY_KEY_REUSED');
    }
    if (record.state !== 'COMPLETED') {
      throw new DomainConflictError('A request with this idempotency key is already in progress', 'IDEMPOTENCY_IN_PROGRESS');
    }
    return this.fromStored(record.response_body);
  }

  async getBalance(accountId: string): Promise<LedgerAccountBalance[]> {
    const result = await this.pool.query<{
      account_id: string; name: string; type: string; currency: string; balance_minor_units: string;
    }>(
      `SELECT account.account_id, account.name, account.type, line.currency,
              SUM(CASE
                WHEN (account.type IN ('ASSET', 'EXPENSE') AND line.side = 'DEBIT')
                  OR (account.type IN ('LIABILITY', 'EQUITY', 'REVENUE') AND line.side = 'CREDIT')
                THEN line.amount_minor_units ELSE -line.amount_minor_units END)::text AS balance_minor_units
         FROM ledger_accounts account
         LEFT JOIN journal_entry_lines line ON line.account_id = account.account_id
        WHERE account.account_id = $1
        GROUP BY account.account_id, account.name, account.type, line.currency
        ORDER BY line.currency NULLS FIRST`,
      [accountId],
    );
    if (!result.rowCount) throw new DomainNotFoundError(`Ledger account not found: ${accountId}`);
    return result.rows.map((row) => ({
      accountId: row.account_id,
      accountName: row.name,
      accountType: row.type,
      currency: row.currency,
      balanceMinorUnits: row.balance_minor_units ?? '0',
    }));
  }

  async getHistory(input: { readonly after?: { readonly postedAt: Date; readonly id: string }; readonly limit: number }): Promise<JournalEntry[]> {
    const result = input.after
      ? await this.pool.query<EntryRow>(
          `${ENTRY_SELECT} WHERE (entry.posted_at, entry.entry_id) < ($1, $2)
            ORDER BY entry.posted_at DESC, entry.entry_id DESC LIMIT $3`,
          [input.after.postedAt, input.after.id, input.limit],
        )
      : await this.pool.query<EntryRow>(
          `${ENTRY_SELECT} ORDER BY entry.posted_at DESC, entry.entry_id DESC LIMIT $1`,
          [input.limit],
        );
    return result.rows.map((row) => this.toDomain(row));
  }

  private async persist(
    entry: JournalEntry,
    reversalOfEntryId?: string,
    idempotency?: LedgerIdempotencyContext,
  ): Promise<JournalEntry> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (idempotency) {
        const replay = await this.acquireIdempotency(client, idempotency);
        if (replay) {
          await client.query('COMMIT');
          return replay;
        }
      }
      await this.insertEntry(client, entry, reversalOfEntryId);
      if (idempotency) {
        await client.query(
          `UPDATE idempotency_keys
              SET state = 'COMPLETED', owner_token = NULL, lease_expires_at = NULL,
                  response_status = 201, response_body = $4::jsonb,
                  expires_at = now() + interval '24 hours', updated_at = now()
            WHERE scope = $1 AND key = $2 AND fingerprint = $3 AND state = 'IN_PROGRESS'`,
          [idempotency.scope, idempotency.key, idempotency.fingerprint, JSON.stringify(this.toStored(entry))],
        );
      }
      await client.query('COMMIT');
      return entry;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (isUniqueViolation(error)) {
        throw new DomainConflictError('Journal entry or reversal already exists', 'JOURNAL_ENTRY_CONFLICT');
      }
      if (hasSqlState(error, '23503')) {
        throw new DomainNotFoundError('Ledger account or journal entry referenced by the posting does not exist');
      }
      if (hasSqlState(error, '23514')) {
        throw new DomainValidationError('Journal entry violates a database ledger invariant', 'INVALID_JOURNAL_ENTRY');
      }
      if (hasSqlState(error, '55000')) {
        throw new DomainConflictError('Posted ledger records are append-only', 'LEDGER_APPEND_ONLY');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async acquireIdempotency(client: PoolClient, context: LedgerIdempotencyContext): Promise<JournalEntry | null> {
    const ownerToken = randomUUID();
    await client.query(
      `INSERT INTO idempotency_keys
         (scope, key, fingerprint, state, owner_token, lease_expires_at, expires_at)
       VALUES ($1, $2, $3, 'IN_PROGRESS', $4, now() + interval '60 seconds', now() + interval '24 hours')
       ON CONFLICT (scope, key) DO UPDATE SET
         fingerprint = EXCLUDED.fingerprint,
         state = 'IN_PROGRESS',
         owner_token = EXCLUDED.owner_token,
         response_status = NULL,
         response_body = NULL,
         lease_expires_at = EXCLUDED.lease_expires_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()
       WHERE idempotency_keys.expires_at <= now()
          OR (idempotency_keys.state = 'IN_PROGRESS' AND idempotency_keys.lease_expires_at <= now())`,
      [context.scope, context.key, context.fingerprint, ownerToken],
    );
    const result = await client.query<{
      fingerprint: string; state: 'IN_PROGRESS' | 'COMPLETED'; response_body: unknown; owner_token: string | null;
    }>(
      `SELECT fingerprint, state, response_body, owner_token FROM idempotency_keys
        WHERE scope = $1 AND key = $2 FOR UPDATE`,
      [context.scope, context.key],
    );
    const record = result.rows[0];
    if (!record) throw new Error('Idempotency record disappeared during posting');
    if (record.fingerprint !== context.fingerprint) {
      throw new DomainConflictError('Idempotency key was used with a different request', 'IDEMPOTENCY_KEY_REUSED');
    }
    if (record.state === 'COMPLETED') return this.fromStored(record.response_body);
    if (record.owner_token === ownerToken) return null;
    throw new DomainConflictError('A request with this idempotency key is already in progress', 'IDEMPOTENCY_IN_PROGRESS');
  }

  private async insertEntry(client: PoolClient, entry: JournalEntry, reversalOfEntryId?: string): Promise<void> {
    await client.query(
      `INSERT INTO journal_entries (entry_id, description, posted_at, reversal_of_entry_id)
       VALUES ($1, $2, $3, $4)`,
      [entry.id, entry.description, entry.postedAt, reversalOfEntryId ?? entry.reversalOfEntryId ?? null],
    );
    for (const [index, line] of entry.lines.entries()) {
      await client.query(
        `INSERT INTO journal_entry_lines (entry_id, line_number, account_id, side, amount_minor_units, currency, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.id, index + 1, line.accountId, line.side, line.amount.minorUnits.toString(), line.amount.currency, line.memo ?? null],
      );
    }
  }

  private toDomain(row: EntryRow): JournalEntry {
    return JournalEntry.create({
      id: row.entry_id,
      description: row.description,
      postedAt: row.posted_at,
      reversalOfEntryId: row.reversal_of_entry_id ?? undefined,
      lines: row.lines.map((line) => ({
        accountId: line.account_id,
        side: line.side,
        amount: Money.fromMinorUnits(BigInt(line.amount_minor), line.currency),
        memo: line.memo ?? undefined,
      })),
    });
  }

  private toStored(entry: JournalEntry): Record<string, unknown> {
    return {
      id: entry.id,
      description: entry.description,
      postedAt: entry.postedAt.toISOString(),
      reversalOfEntryId: entry.reversalOfEntryId,
      lines: entry.lines.map((line) => ({
        accountId: line.accountId,
        side: line.side,
        amount: line.amount.toJSON(),
        memo: line.memo,
      })),
    };
  }

  private fromStored(value: unknown): JournalEntry {
    const stored = value as {
      id: string; description: string; postedAt: string; reversalOfEntryId?: string;
      lines: Array<{ accountId: string; side: JournalLine['side']; amount: { minorUnits: string; currency: string }; memo?: string }>;
    };
    return JournalEntry.create({
      id: stored.id,
      description: stored.description,
      postedAt: new Date(stored.postedAt),
      reversalOfEntryId: stored.reversalOfEntryId,
      lines: stored.lines.map((line) => ({ ...line, amount: Money.fromMinorUnits(BigInt(line.amount.minorUnits), line.amount.currency) })),
    });
  }
}

const ENTRY_SELECT = `SELECT entry.entry_id, entry.description, entry.posted_at, entry.reversal_of_entry_id,
       COALESCE((SELECT json_agg(json_build_object(
         'account_id', line.account_id, 'side', line.side,
         'amount_minor', line.amount_minor_units::text, 'currency', line.currency, 'memo', line.memo
       ) ORDER BY line.line_number) FROM journal_entry_lines line WHERE line.entry_id = entry.entry_id), '[]'::json) AS lines
  FROM journal_entries entry`;

function isUniqueViolation(error: unknown): boolean {
  return hasSqlState(error, '23505');
}

function hasSqlState(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
