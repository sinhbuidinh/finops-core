import { DomainValidationError } from '../../../shared/domain/domain-error.js';

export class InventoryItem {
  private constructor(
    readonly id: string,
    readonly totalQty: number,
    readonly reservedQty: number,
    readonly version: number,
  ) {}

  static create(input: { id: string; totalQty: number; reservedQty?: number; version?: number }): InventoryItem {
    const reservedQty = input.reservedQty ?? 0;
    if (!input.id.trim() || !Number.isSafeInteger(input.totalQty) || input.totalQty < 0 ||
        !Number.isSafeInteger(reservedQty) || reservedQty < 0 || reservedQty > input.totalQty ||
        !Number.isSafeInteger(input.version ?? 0) || (input.version ?? 0) < 0) {
      throw new DomainValidationError('Inventory quantities and version must be valid non-negative integers', 'INVALID_INVENTORY_ITEM');
    }
    return new InventoryItem(input.id, input.totalQty, reservedQty, input.version ?? 0);
  }

  get availableQty(): number { return this.totalQty - this.reservedQty; }
}
