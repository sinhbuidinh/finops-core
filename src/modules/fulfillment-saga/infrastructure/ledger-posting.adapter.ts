import { Injectable } from '@nestjs/common';
import type { LedgerPostingPort } from '../application/ledger-posting.port.js';
import type { LedgerIdempotencyContext } from '../../ledger/application/ledger-entry-repository.port.js';
import type { JournalEntry } from '../../ledger/domain/journal-entry.js';
import { LedgerService } from '../../ledger/ledger.service.js';

@Injectable()
export class LedgerPostingAdapter implements LedgerPostingPort {
  constructor(private readonly ledger: LedgerService) {}
  post(entry: JournalEntry, idempotency: LedgerIdempotencyContext): Promise<JournalEntry> {
    return this.ledger.post(entry, idempotency.key);
  }
  reverse(originalEntryId: string, reversalEntryId: string, idempotency: LedgerIdempotencyContext): Promise<JournalEntry> {
    return this.ledger.reverse(originalEntryId, reversalEntryId, idempotency.key);
  }
}
