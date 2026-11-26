import { DomainValidationError } from '../../../shared/domain/domain-error.js';

export class StockReservation {
  private constructor(
    readonly id: string,
    readonly itemId: string,
    readonly quantity: number,
    readonly status: 'ACTIVE' | 'RELEASED',
  ) {}

  static create(input: { id: string; itemId: string; quantity: number; status?: 'ACTIVE' | 'RELEASED' }): StockReservation {
    if (!input.id.trim() || !input.itemId.trim() || !Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
      throw new DomainValidationError('Reservation requires item and ID and a positive integer quantity', 'INVALID_STOCK_RESERVATION');
    }
    return new StockReservation(input.id, input.itemId, input.quantity, input.status ?? 'ACTIVE');
  }
}
