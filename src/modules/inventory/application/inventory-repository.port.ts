import type { InventoryItem } from '../domain/inventory-item.js';
import type { StockReservation } from '../domain/stock-reservation.js';

export interface InventoryRepositoryPort {
  createItem(item: InventoryItem): Promise<InventoryItem>;
  findItem(itemId: string): Promise<InventoryItem | null>;
  reserve(itemId: string, quantity: number): Promise<StockReservation>;
  release(reservationId: string): Promise<StockReservation>;
}

export const INVENTORY_REPOSITORY = Symbol('INVENTORY_REPOSITORY');
