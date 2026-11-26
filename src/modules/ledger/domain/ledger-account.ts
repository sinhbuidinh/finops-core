import { DomainValidationError } from '../../../shared/domain/domain-error.js';

export const LEDGER_ACCOUNT_TYPES = [
  'ASSET',
  'LIABILITY',
  'EQUITY',
  'REVENUE',
  'EXPENSE',
] as const;

export type LedgerAccountType = (typeof LEDGER_ACCOUNT_TYPES)[number];

/** A chart-of-accounts entry. Balances are derived from journal entries. */
export class LedgerAccount {
  private constructor(
    readonly id: string,
    readonly name: string,
    readonly type: LedgerAccountType,
  ) {}

  static create(input: {
    id: string;
    name: string;
    type: LedgerAccountType;
  }): LedgerAccount {
    if (!input.id.trim()) throw new DomainValidationError('Account id is required', 'INVALID_LEDGER_ACCOUNT');
    if (!input.name.trim()) throw new DomainValidationError('Account name is required', 'INVALID_LEDGER_ACCOUNT');
    if (!(LEDGER_ACCOUNT_TYPES as readonly string[]).includes(input.type)) {
      throw new DomainValidationError(`Invalid account type: ${input.type}`, 'INVALID_LEDGER_ACCOUNT_TYPE');
    }
    return new LedgerAccount(input.id, input.name.trim(), input.type);
  }
}
