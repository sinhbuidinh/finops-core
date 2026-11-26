import { DomainConflictError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { Money } from '../../../shared/domain/money.js';

export const JOURNAL_SIDES = {
  DEBIT: 'DEBIT',
  CREDIT: 'CREDIT',
} as const;

export type JournalSide = (typeof JOURNAL_SIDES)[keyof typeof JOURNAL_SIDES];

export interface JournalLine {
  readonly accountId: string;
  readonly side: JournalSide;
  readonly amount: Money;
  readonly memo?: string;
}

export interface JournalEntryInput {
  readonly id: string;
  readonly description: string;
  readonly lines: readonly JournalLine[];
  readonly postedAt?: Date;
  readonly reversalOfEntryId?: string;
}

/** Immutable, posted double-entry journal record. Corrections are new entries. */
export class JournalEntry {
  readonly lines: readonly JournalLine[];
  private readonly postingDate: Date;

  get postedAt(): Date {
    return new Date(this.postingDate);
  }

  private constructor(
    readonly id: string,
    readonly description: string,
    lines: readonly JournalLine[],
    postedAt: Date,
    readonly reversalOfEntryId?: string,
  ) {
    this.lines = Object.freeze(lines.map((line) => Object.freeze({ ...line })));
    this.postingDate = new Date(postedAt);
    Object.freeze(this);
  }

  static create(input: JournalEntryInput): JournalEntry {
    if (!input.id.trim()) throw new DomainValidationError('Journal entry id is required', 'INVALID_JOURNAL_ENTRY');
    if (!input.description.trim()) throw new DomainValidationError('Journal entry description is required', 'INVALID_JOURNAL_ENTRY');
    if (input.lines.length < 2) {
      throw new DomainValidationError('A journal entry must contain at least two lines', 'INVALID_JOURNAL_LINES');
    }

    const currency = input.lines[0]?.amount.currency;
    let debits = 0n;
    let credits = 0n;
    for (const line of input.lines) {
      if (!line.accountId.trim()) throw new DomainValidationError('Journal line account id is required', 'INVALID_JOURNAL_LINE');
      if (line.side !== JOURNAL_SIDES.DEBIT && line.side !== JOURNAL_SIDES.CREDIT) {
        throw new DomainValidationError(`Invalid journal side: ${line.side}`, 'INVALID_JOURNAL_SIDE');
      }
      if (line.amount.minorUnits <= 0n) {
        throw new DomainValidationError('Journal line amounts must be positive', 'INVALID_JOURNAL_AMOUNT');
      }
      if (line.amount.currency !== currency) {
        throw new DomainValidationError('All lines in an entry must use the same currency', 'JOURNAL_CURRENCY_MISMATCH');
      }
      if (line.side === JOURNAL_SIDES.DEBIT) debits += line.amount.minorUnits;
      else credits += line.amount.minorUnits;
    }
    if (debits !== credits) {
      throw new DomainValidationError('Journal entry debits must equal credits', 'UNBALANCED_JOURNAL_ENTRY');
    }
    if (input.reversalOfEntryId === input.id) {
      throw new DomainConflictError('A journal entry cannot reverse itself', 'INVALID_JOURNAL_REVERSAL');
    }
    const postedAt = input.postedAt ?? new Date();
    if (Number.isNaN(postedAt.getTime())) throw new DomainValidationError('Invalid posting date', 'INVALID_JOURNAL_ENTRY');
    return new JournalEntry(input.id.trim(), input.description.trim(), input.lines, postedAt, input.reversalOfEntryId);
  }

  static reversalOf(id: string, original: JournalEntry, postedAt = new Date()): JournalEntry {
    return JournalEntry.create({
      id,
      description: `Reversal of ${original.id}`,
      postedAt,
      reversalOfEntryId: original.id,
      lines: original.lines.map((line) => ({
        ...line,
        side: line.side === JOURNAL_SIDES.DEBIT ? JOURNAL_SIDES.CREDIT : JOURNAL_SIDES.DEBIT,
      })),
    });
  }

  toJSON(): Record<string, unknown> {
    return {
      id: this.id,
      description: this.description,
      postedAt: this.postedAt.toISOString(),
      reversalOfEntryId: this.reversalOfEntryId ?? null,
      lines: this.lines.map((line) => ({
        accountId: line.accountId,
        side: line.side,
        amount: line.amount.toJSON(),
        ...(line.memo !== undefined && { memo: line.memo }),
      })),
    };
  }
}
