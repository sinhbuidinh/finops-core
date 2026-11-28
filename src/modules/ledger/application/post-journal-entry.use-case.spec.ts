import { Money } from '../../../shared/domain/money.js';
import { JOURNAL_SIDES } from '../domain/journal-entry.js';
import type { LedgerEntryRepositoryPort } from './ledger-entry-repository.port.js';
import { PostJournalEntryUseCase } from './post-journal-entry.use-case.js';

describe('PostJournalEntryUseCase', () => {
  it('validates and persists the new journal entry', async () => {
    const save = vi.fn(async (entry) => entry);
    const entries: LedgerEntryRepositoryPort = {
      save,
      findById: vi.fn(),
      findReversalOf: vi.fn(),
      findIdempotentResult: vi.fn(),
      saveReversal: vi.fn(),
    };
    const useCase = new PostJournalEntryUseCase(entries);
    const result = await useCase.execute({
      id: 'entry-1',
      description: 'Sale',
      lines: [
        { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: Money.fromMinorUnits(80n, 'USD') },
        { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: Money.fromMinorUnits(80n, 'USD') },
      ],
    });

    expect(save).toHaveBeenCalledWith(result, undefined, undefined);
    expect(result.id).toBe('entry-1');
  });
});
