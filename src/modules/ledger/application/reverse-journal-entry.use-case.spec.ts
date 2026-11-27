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
    findIdempotentResult: vi.fn().mockResolvedValue(null),
    saveReversal: vi.fn(async (_originalId, reversal) => reversal),
    ...overrides,
  };
}

describe('ReverseJournalEntryUseCase', () => {
  it('appends a reversal and leaves the original entry unchanged', async () => {
    const save = vi.fn();
    const saveReversal = vi.fn(async (_originalId, reversal) => reversal);
    const entries = repository({ save, saveReversal });
    const useCase = new ReverseJournalEntryUseCase(entries);
    const before = original.lines.map(({ side, amount }) => [side, amount.toJSON()]);
    const reversal = await useCase.execute({ originalEntryId: original.id, reversalEntryId: 'entry-2' });

    expect(reversal.reversalOfEntryId).toBe(original.id);
    expect(saveReversal).toHaveBeenCalledWith(original.id, reversal, undefined);
    expect(save).not.toHaveBeenCalled();
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

  it('returns an idempotent replay before checking the original entry', async () => {
    const replay = JournalEntry.reversalOf('entry-replay', original);
    const findById = vi.fn();
    const entries = repository({ findIdempotentResult: vi.fn().mockResolvedValue(replay), findById });
    const result = await new ReverseJournalEntryUseCase(entries).execute({
      originalEntryId: original.id,
      reversalEntryId: replay.id,
      idempotency: { scope: 'ledger:reverse', key: 'key', fingerprint: 'fingerprint' },
    });
    expect(result).toBe(replay);
    expect(findById).not.toHaveBeenCalled();
  });

  it('creates a reversal when no completed idempotency result exists', async () => {
    const findIdempotentResult = vi.fn().mockResolvedValue(null);
    const saveReversal = vi.fn(async (_originalId, reversal) => reversal);
    const entries = repository({ findIdempotentResult, saveReversal });
    const result = await new ReverseJournalEntryUseCase(entries).execute({
      originalEntryId: original.id,
      reversalEntryId: 'entry-with-idempotency',
      idempotency: { scope: 'ledger:reverse', key: 'key', fingerprint: 'fingerprint' },
    });
    expect(findIdempotentResult).toHaveBeenCalledOnce();
    expect(saveReversal).toHaveBeenCalledWith(original.id, result, {
      scope: 'ledger:reverse', key: 'key', fingerprint: 'fingerprint',
    });
  });
});
