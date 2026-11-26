import { InvalidCurrencyError } from './domain-error.js';
import { currencyCode } from './currency-code.js';

describe('currencyCode', () => {
  it('accepts runtime-supported uppercase ISO currency codes', () => {
    expect(currencyCode('USD')).toBe('USD');
  });

  it.each(['usd', 'US', 'ZZZ'])('rejects invalid or unsupported code %s', (code) => {
    expect(() => currencyCode(code)).toThrow(InvalidCurrencyError);
  });
});
