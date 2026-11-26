import { DomainConflictError, DomainNotFoundError } from '../../../shared/domain/domain-error.js';
import { Money } from '../../../shared/domain/money.js';
import { JOURNAL_SIDES, JournalEntry } from '../domain/journal-entry.js';
import type { LedgerEntryRepositoryPort } from './ledger-entry-repository.port.js';
import { ReverseJournalEntryUseCase } from './reverse-journal-entry.use-case.js';

const original = JournalEntry.create({
  id: 'entry-1',
  description: 'Sale',
  lines: [
    { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: Money.fromMinorUnits(80n, 'USD') },
    { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: Money.fromMinorUnits(80n, 'USD') },
  ],
});

function repository(overrides: Partial<LedgerEntryRepositoryPort> = {}): LedgerEntryRepositoryPort {
  return {
    save: vi.fn(),
    findById: vi.fn().mockResolvedValue(original),
    findReversalOf: vi.fn().mockResolvedValue(null),
    saveReversal: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ReverseJournalEntryUseCase', () => {
  it('appends a reversal and leaves the original entry unchanged', async () => {
    const entries = repository();
    const useCase = new ReverseJournalEntryUseCase(entries);
    const before = original.lines.map(({ side, amount }) => [side, amount.toJSON()]);
    const reversal = await useCase.execute({ originalEntryId: original.id, reversalEntryId: 'entry-2' });

    expect(reversal.reversalOfEntryId).toBe(original.id);
    expect(entries.saveReversal).toHaveBeenCalledWith(original.id, reversal);
    expect(entries.save).not.toHaveBeenCalled();
    expect(original.lines.map(({ side, amount }) => [side, amount.toJSON()])).toEqual(before);
  });

  it('rejects a missing entry, a reversal of a reversal, and an already reversed entry', async () => {
    await expect(new ReverseJournalEntryUseCase(repository({ findById: vi.fn().mockResolvedValue(null) }))
      .execute({ originalEntryId: 'missing', reversalEntryId: 'entry-2' })).rejects.toThrow(DomainNotFoundError);

    const reversalEntry = JournalEntry.reversalOf('entry-reversal', original);
    await expect(new ReverseJournalEntryUseCase(repository({ findById: vi.fn().mockResolvedValue(reversalEntry) }))
      .execute({ originalEntryId: reversalEntry.id, reversalEntryId: 'entry-3' })).rejects.toThrow(DomainConflictError);

    await expect(new ReverseJournalEntryUseCase(repository({ findReversalOf: vi.fn().mockResolvedValue(reversalEntry) }))
      .execute({ originalEntryId: original.id, reversalEntryId: 'entry-4' })).rejects.toThrow(DomainConflictError);
  });
});
