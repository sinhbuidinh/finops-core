import type { JournalEntryInput } from '../domain/journal-entry.js';
import { JournalEntry } from '../domain/journal-entry.js';
import type { LedgerEntryRepositoryPort, LedgerIdempotencyContext } from './ledger-entry-repository.port.js';

export class PostJournalEntryUseCase {
  constructor(private readonly entries: LedgerEntryRepositoryPort) {}

  async execute(input: JournalEntryInput, idempotency?: LedgerIdempotencyContext): Promise<JournalEntry> {
    const entry = JournalEntry.create(input);
    return this.entries.save(entry, idempotency);
  }
}
