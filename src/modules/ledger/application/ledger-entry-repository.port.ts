import type { JournalEntry } from '../domain/journal-entry.js';

/** Persistence boundary; implementations must commit each operation atomically. */
export interface LedgerEntryRepositoryPort {
  save(entry: JournalEntry): Promise<void>;
  findById(id: string): Promise<JournalEntry | null>;
  findReversalOf(originalEntryId: string): Promise<JournalEntry | null>;
  /** Must enforce one reversal per original atomically (for example, a unique constraint). */
  saveReversal(originalEntryId: string, reversal: JournalEntry): Promise<void>;
}

export const LEDGER_ENTRY_REPOSITORY = Symbol('LEDGER_ENTRY_REPOSITORY');
