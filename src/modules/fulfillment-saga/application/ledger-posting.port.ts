import type { JournalEntry } from '../../ledger/domain/journal-entry.js';
import type { LedgerIdempotencyContext } from '../../ledger/application/ledger-entry-repository.port.js';

export interface LedgerPostingPort {
  post(entry: JournalEntry, idempotency: LedgerIdempotencyContext): Promise<JournalEntry>;
  reverse(originalEntryId: string, reversalEntryId: string, idempotency: LedgerIdempotencyContext): Promise<JournalEntry>;
}

export const LEDGER_POSTING_PORT = Symbol('LEDGER_POSTING_PORT');
