import { CurrencyMismatchError, InvalidMoneyAmountError } from './domain-error.js';
import { currencyCode, type CurrencyCode } from './currency-code.js';

/** Monetary value stored in the currency's smallest unit (for example, cents). */
export class Money {
  private constructor(
    readonly minorUnits: bigint,
    readonly currency: CurrencyCode,
  ) {}

  static fromMinorUnits(minorUnits: bigint, currency: string): Money {
    if (typeof minorUnits !== 'bigint') {
      throw new InvalidMoneyAmountError();
    }

    return new Money(minorUnits, currencyCode(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromMinorUnits(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return Money.fromMinorUnits(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  toString(): string {
    return `${this.minorUnits} ${this.currency}`;
  }

  toJSON(): { minorUnits: string; currency: CurrencyCode } {
    return { minorUnits: this.minorUnits.toString(), currency: this.currency };
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
