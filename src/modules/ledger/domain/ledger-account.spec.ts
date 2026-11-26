import { DomainValidationError } from '../../../shared/domain/domain-error.js';
import { LEDGER_ACCOUNT_TYPES, LedgerAccount } from './ledger-account.js';

describe('LedgerAccount', () => {
  it('creates accounts for every supported type', () => {
    for (const type of LEDGER_ACCOUNT_TYPES) {
      expect(LedgerAccount.create({ id: `account-${type}`, name: ' Cash ', type })).toMatchObject({
        id: `account-${type}`,
        name: 'Cash',
        type,
      });
    }
  });

  it('rejects missing identifiers or names and unsupported account types', () => {
    expect(() => LedgerAccount.create({ id: ' ', name: 'Cash', type: 'ASSET' })).toThrow(DomainValidationError);
    expect(() => LedgerAccount.create({ id: 'cash', name: ' ', type: 'ASSET' })).toThrow(DomainValidationError);
    expect(() => LedgerAccount.create({ id: 'cash', name: 'Cash', type: 'OTHER' as never })).toThrow(DomainValidationError);
  });
});
