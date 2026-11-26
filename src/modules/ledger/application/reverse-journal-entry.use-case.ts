import { DomainConflictError, DomainNotFoundError } from '../../../shared/domain/domain-error.js';
import { JournalEntry } from '../domain/journal-entry.js';
import type { LedgerEntryRepositoryPort } from './ledger-entry-repository.port.js';

export interface ReverseJournalEntryInput {
  readonly originalEntryId: string;
  readonly reversalEntryId: string;
  readonly postedAt?: Date;
}

export class ReverseJournalEntryUseCase {
  constructor(private readonly entries: LedgerEntryRepositoryPort) {}

  async execute(input: ReverseJournalEntryInput): Promise<JournalEntry> {
    const original = await this.entries.findById(input.originalEntryId);
    if (!original) throw new DomainNotFoundError(`Journal entry not found: ${input.originalEntryId}`);
    if (original.reversalOfEntryId) {
      throw new DomainConflictError('A reversal entry cannot itself be reversed', 'JOURNAL_REVERSAL_OF_REVERSAL');
    }
    if (await this.entries.findReversalOf(original.id)) {
      throw new DomainConflictError('Journal entry has already been reversed', 'JOURNAL_ENTRY_ALREADY_REVERSED');
    }

    const reversal = JournalEntry.reversalOf(input.reversalEntryId, original, input.postedAt);
    // The port operation must have a uniqueness constraint to close the race between concurrent reversals.
    await this.entries.saveReversal(original.id, reversal);
    return reversal;
  }
}
