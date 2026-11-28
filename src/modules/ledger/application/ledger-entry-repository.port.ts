import type { JournalEntry } from '../domain/journal-entry.js';

/** Persistence boundary; implementations must commit each operation atomically. */
export interface LedgerEntryRepositoryPort {
  save(entry: JournalEntry, idempotency?: LedgerIdempotencyContext, tenantId?: string): Promise<JournalEntry>;
  findById(id: string, tenantId?: string): Promise<JournalEntry | null>;
  findReversalOf(originalEntryId: string, tenantId?: string): Promise<JournalEntry | null>;
  findIdempotentResult(context: LedgerIdempotencyContext): Promise<JournalEntry | null>;
  /** Must enforce one reversal per original atomically (for example, a unique constraint). */
  saveReversal(originalEntryId: string, reversal: JournalEntry, idempotency?: LedgerIdempotencyContext, tenantId?: string): Promise<JournalEntry>;
}

export interface LedgerIdempotencyContext {
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
}

export const LEDGER_ENTRY_REPOSITORY = Symbol('LEDGER_ENTRY_REPOSITORY');
