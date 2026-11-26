import { InvalidCurrencyError } from './domain-error.js';

/** A validated ISO 4217 currency code supported by this Node.js runtime. */
export type CurrencyCode = string & { readonly __currencyCode: unique symbol };

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const SUPPORTED_CURRENCY_CODES = new Set(Intl.supportedValuesOf('currency'));

export function currencyCode(value: string): CurrencyCode {
  if (!CURRENCY_CODE_PATTERN.test(value) || !SUPPORTED_CURRENCY_CODES.has(value)) {
    throw new InvalidCurrencyError(value);
  }

  return value as CurrencyCode;
}
