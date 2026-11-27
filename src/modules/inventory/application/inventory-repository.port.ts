import type { InventoryItem } from '../domain/inventory-item.js';
import type { StockReservation } from '../domain/stock-reservation.js';

export interface InventoryRepositoryPort {
  createItem(item: InventoryItem): Promise<InventoryItem>;
  findItem(tenantId: string, itemId: string): Promise<InventoryItem | null>;
  reserve(tenantId: string, itemId: string, quantity: number, idempotencyKey?: string): Promise<StockReservation>;
  release(tenantId: string, reservationId: string): Promise<StockReservation>;
}

export const INVENTORY_REPOSITORY = Symbol('INVENTORY_REPOSITORY');
