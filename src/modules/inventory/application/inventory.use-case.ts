import { DomainNotFoundError } from '../../../shared/domain/domain-error.js';
import type { InventoryRepositoryPort } from './inventory-repository.port.js';
import { InventoryItem } from '../domain/inventory-item.js';
import type { StockReservation } from '../domain/stock-reservation.js';

export class InventoryUseCase {
  constructor(private readonly repository: InventoryRepositoryPort) {}

  createItem(input: { id: string; totalQty: number }): Promise<InventoryItem> {
    return this.repository.createItem(InventoryItem.create(input));
  }

  async getItem(itemId: string): Promise<InventoryItem> {
    const item = await this.repository.findItem(itemId);
    if (!item) throw new DomainNotFoundError(`Inventory item not found: ${itemId}`);
    return item;
  }

  reserve(itemId: string, quantity: number): Promise<StockReservation> {
    return this.repository.reserve(itemId, quantity);
  }

  release(reservationId: string): Promise<StockReservation> {
    return this.repository.release(reservationId);
  }
}
