import { DomainValidationError } from '../../../shared/domain/domain-error.js';
import { InventoryItem } from './inventory-item.js';

describe('InventoryItem', () => {
  it('defaults reserved quantity and version and computes availability', () => {
    const item = InventoryItem.create({ id: 'sku-1', totalQty: 12 });
    expect(item).toMatchObject({ id: 'sku-1', totalQty: 12, reservedQty: 0, version: 0, availableQty: 12 });
    expect(InventoryItem.create({ id: 'sku-2', totalQty: 9, reservedQty: 4, version: 3 }).availableQty).toBe(5);
  });

  it.each([
    { id: '', totalQty: 1 },
    { id: 'sku', totalQty: -1 },
    { id: 'sku', totalQty: 1.5 },
    { id: 'sku', totalQty: Number.MAX_SAFE_INTEGER + 1 },
    { id: 'sku', totalQty: 1, reservedQty: -1 },
    { id: 'sku', totalQty: 1, reservedQty: 2 },
    { id: 'sku', totalQty: 1, reservedQty: 0.5 },
    { id: 'sku', totalQty: 1, version: -1 },
    { id: 'sku', totalQty: 1, version: 0.5 },
  ])('rejects invalid inventory input %#', (input) => {
    expect(() => InventoryItem.create(input)).toThrow(DomainValidationError);
  });
});
