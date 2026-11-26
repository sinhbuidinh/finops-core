export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class DomainValidationError extends DomainError {
  constructor(message: string, code = 'DOMAIN_VALIDATION') {
    super(message, code);
  }
}

export class DomainConflictError extends DomainError {
  constructor(message: string, code = 'DOMAIN_CONFLICT') {
    super(message, code);
  }
}

export class DomainNotFoundError extends DomainError {
  constructor(message: string, code = 'DOMAIN_NOT_FOUND') {
    super(message, code);
  }
}

export class InvalidCurrencyError extends DomainValidationError {
  constructor(currency: string) {
    super(`Invalid currency code: ${currency}`, 'INVALID_CURRENCY');
  }
}

export class CurrencyMismatchError extends DomainValidationError {
  constructor(left: string, right: string) {
    super(`Currency mismatch: ${left} and ${right}`, 'CURRENCY_MISMATCH');
  }
}

export class InvalidMoneyAmountError extends DomainValidationError {
  constructor() {
    super('Money minor units must be a bigint', 'INVALID_MONEY_AMOUNT');
  }
}
