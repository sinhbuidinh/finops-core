import {
  CurrencyMismatchError,
  InvalidMoneyAmountError,
} from './domain-error.js';
import { Money } from './money.js';

describe('Money', () => {
  it('requires bigint minor units and a supported currency', () => {
    expect(() => Money.fromMinorUnits(1 as never, 'USD')).toThrow(InvalidMoneyAmountError);
    expect(() => Money.fromMinorUnits(1n, 'usd')).toThrow('Invalid currency code: usd');
  });

  it('adds, subtracts, negates, compares, and serializes minor units exactly', () => {
    const first = Money.fromMinorUnits(125n, 'USD');
    const second = Money.fromMinorUnits(25n, 'USD');

    expect(first.add(second).minorUnits).toBe(150n);
    expect(first.subtract(second).minorUnits).toBe(100n);
    expect(first.negate().minorUnits).toBe(-125n);
    expect(Money.fromMinorUnits(0n, 'USD').isZero()).toBe(true);
    expect(first.equals(Money.fromMinorUnits(125n, 'USD'))).toBe(true);
    expect(first.equals(second)).toBe(false);
    expect(first.equals(Money.fromMinorUnits(125n, 'EUR'))).toBe(false);
    expect(first.toString()).toBe('125 USD');
    expect(first.toJSON()).toEqual({ minorUnits: '125', currency: 'USD' });
  });

  it('rejects arithmetic across currencies', () => {
    const usd = Money.fromMinorUnits(1n, 'USD');
    const eur = Money.fromMinorUnits(1n, 'EUR');
    expect(() => usd.add(eur)).toThrow(CurrencyMismatchError);
    expect(() => usd.subtract(eur)).toThrow(CurrencyMismatchError);
  });
});
