import type { JournalEntry } from '../../ledger/domain/journal-entry.js';
import type { LedgerIdempotencyContext } from '../../ledger/application/ledger-entry-repository.port.js';

export interface LedgerPostingPort {
  postWalletPayment(input: { tenantId: string; walletId: string; entryId: string; description: string; postedAt?: string; amount: { minorUnits: string; currency: string } }, idempotency: LedgerIdempotencyContext): Promise<JournalEntry>;
  reverse(originalEntryId: string, reversalEntryId: string, tenantId: string, idempotency: LedgerIdempotencyContext): Promise<JournalEntry>;
}

export const LEDGER_POSTING_PORT = Symbol('LEDGER_POSTING_PORT');
