import { DomainValidationError } from '../../../shared/domain/domain-error.js';
import { StockReservation } from './stock-reservation.js';

describe('StockReservation', () => {
  it('creates active reservations by default and preserves released status', () => {
    expect(StockReservation.create({ id: 'r1', itemId: 'sku1', quantity: 2 }).status).toBe('ACTIVE');
    expect(StockReservation.create({ id: 'r2', itemId: 'sku1', quantity: 2, status: 'RELEASED' })).toMatchObject({ id: 'r2', status: 'RELEASED' });
  });

  it.each([
    { id: '', itemId: 'sku', quantity: 1 },
    { id: 'r', itemId: '', quantity: 1 },
    { id: 'r', itemId: 'sku', quantity: 0 },
    { id: 'r', itemId: 'sku', quantity: -1 },
    { id: 'r', itemId: 'sku', quantity: 1.1 },
  ])('rejects invalid reservation input %#', (input) => {
    expect(() => StockReservation.create(input)).toThrow(DomainValidationError);
  });
});
