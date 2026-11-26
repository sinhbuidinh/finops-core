import type { JournalEntryInput } from '../domain/journal-entry.js';
import { JournalEntry } from '../domain/journal-entry.js';
import type { LedgerEntryRepositoryPort } from './ledger-entry-repository.port.js';

export class PostJournalEntryUseCase {
  constructor(private readonly entries: LedgerEntryRepositoryPort) {}

  async execute(input: JournalEntryInput): Promise<JournalEntry> {
    const entry = JournalEntry.create(input);
    await this.entries.save(entry);
    return entry;
  }
}
