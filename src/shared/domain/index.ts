export { AggregateRoot } from './aggregate-root.js';
export type { DomainEvent } from './domain-event.js';
export {
  CurrencyMismatchError,
  DomainConflictError,
  DomainError,
  DomainNotFoundError,
  DomainValidationError,
  InvalidCurrencyError,
  InvalidMoneyAmountError,
} from './domain-error.js';
export { currencyCode, type CurrencyCode } from './currency-code.js';
export { Money } from './money.js';
export { err, ok, type Err, type Ok, type Result } from './result.js';
