import { DomainConflictError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { Money } from '../../../shared/domain/money.js';
import { JOURNAL_SIDES, JournalEntry } from './journal-entry.js';

const money = (minorUnits: bigint, currency = 'USD') => Money.fromMinorUnits(minorUnits, currency);
const balancedLines = () => [
  { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: money(125n) },
  { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: money(125n) },
];
const input = (overrides: Partial<Parameters<typeof JournalEntry.create>[0]> = {}) => ({
  id: 'entry-1',
  description: 'Sale',
  lines: balancedLines(),
  postedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('JournalEntry', () => {
  it('creates a balanced immutable entry', () => {
    const lines = balancedLines();
    const entry = JournalEntry.create(input({ lines }));

    expect(entry.lines).toHaveLength(2);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.lines)).toBe(true);
    expect(() => (entry.lines as unknown[]).push({})).toThrow();
    const postedAt = entry.postedAt;
    postedAt.setFullYear(2000);
    expect(entry.postedAt.getUTCFullYear()).toBe(2026);
  });

  it('rejects unbalanced, short, non-positive, mixed-currency, invalid-side, and incomplete entries', () => {
    expect(() => JournalEntry.create(input({ lines: [
      { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: money(125n) },
      { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: money(124n) },
    ] }))).toThrow(DomainValidationError);
    expect(() => JournalEntry.create(input({ lines: [balancedLines()[0]!] }))).toThrow(DomainValidationError);
    expect(() => JournalEntry.create(input({ lines: [
      { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: money(0n) },
      { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: money(0n) },
    ] }))).toThrow(DomainValidationError);
    expect(() => JournalEntry.create(input({ lines: [
      { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: money(125n) },
      { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: money(125n, 'EUR') },
    ] }))).toThrow(DomainValidationError);
    expect(() => JournalEntry.create(input({ lines: [
      { accountId: 'cash', side: 'OTHER' as never, amount: money(125n) },
      { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: money(125n) },
    ] }))).toThrow(DomainValidationError);
    expect(() => JournalEntry.create(input({ id: ' ' }))).toThrow(DomainValidationError);
    expect(() => JournalEntry.create(input({ description: ' ' }))).toThrow(DomainValidationError);
    expect(() => JournalEntry.create(input({ postedAt: new Date('invalid') }))).toThrow(DomainValidationError);
  });

  it('creates a balanced reversal with opposite sides and a reference to the original', () => {
    const original = JournalEntry.create(input());
    const reversal = JournalEntry.reversalOf('entry-2', original);

    expect(reversal.reversalOfEntryId).toBe(original.id);
    expect(reversal.lines.map(({ accountId, side, amount }) => ({ accountId, side, amount: amount.toJSON() }))).toEqual([
      { accountId: 'cash', side: JOURNAL_SIDES.CREDIT, amount: { minorUnits: '125', currency: 'USD' } },
      { accountId: 'revenue', side: JOURNAL_SIDES.DEBIT, amount: { minorUnits: '125', currency: 'USD' } },
    ]);
  });

  it('rejects an entry reversing itself', () => {
    expect(() => JournalEntry.create(input({ reversalOfEntryId: 'entry-1' }))).toThrow(DomainConflictError);
  });
});
