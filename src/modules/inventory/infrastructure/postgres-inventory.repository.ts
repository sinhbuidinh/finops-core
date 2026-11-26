import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { POSTGRES_POOL } from '../../../shared/infrastructure/database/database.module.js';
import type { Pool } from 'pg';
import { InventoryItem } from '../domain/inventory-item.js';
import { StockReservation } from '../domain/stock-reservation.js';
import type { InventoryRepositoryPort } from '../application/inventory-repository.port.js';

interface ItemRow { item_id: string; total_qty: number; reserved_qty: number; version: number; }
interface ReservationRow { reservation_id: string; item_id: string; quantity: number; status: 'ACTIVE' | 'RELEASED'; }

@Injectable()
export class PostgresInventoryRepository implements InventoryRepositoryPort {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async createItem(item: InventoryItem): Promise<InventoryItem> {
    try {
      const result = await this.pool.query<ItemRow>(
        `INSERT INTO inventory_items (item_id, total_qty) VALUES ($1, $2)
         RETURNING item_id, total_qty, reserved_qty, version`, [item.id, item.totalQty],
      );
      return this.toItem(result.rows[0]!);
    } catch (error) {
      if (sqlState(error, '23505')) throw new DomainConflictError(`Inventory item already exists: ${item.id}`, 'INVENTORY_ITEM_EXISTS');
      throw error;
    }
  }

  async findItem(itemId: string): Promise<InventoryItem | null> {
    const result = await this.pool.query<ItemRow>(
      'SELECT item_id, total_qty, reserved_qty, version FROM inventory_items WHERE item_id = $1', [itemId],
    );
    return result.rows[0] ? this.toItem(result.rows[0]) : null;
  }

  async reserve(itemId: string, quantity: number): Promise<StockReservation> {
    // Validate before touching the database; availability is enforced by the conditional UPDATE.
    StockReservation.create({ id: 'validation', itemId, quantity });
    const client = await this.pool.connect();
    const reservationId = randomUUID();
    try {
      await client.query('BEGIN');
      const updated = await client.query(
        `UPDATE inventory_items
            SET reserved_qty = reserved_qty + $2, version = version + 1, updated_at = now()
          WHERE item_id = $1 AND total_qty - reserved_qty >= $2
          RETURNING item_id`, [itemId, quantity],
      );
      if (!updated.rowCount) {
        const exists = await client.query('SELECT 1 FROM inventory_items WHERE item_id = $1', [itemId]);
        if (!exists.rowCount) throw new DomainNotFoundError(`Inventory item not found: ${itemId}`);
        throw new DomainConflictError('Insufficient available inventory', 'INSUFFICIENT_INVENTORY');
      }
      await client.query(
        `INSERT INTO stock_reservations (reservation_id, item_id, quantity)
         VALUES ($1, $2, $3)`, [reservationId, itemId, quantity],
      );
      await client.query('COMMIT');
      return StockReservation.create({ id: reservationId, itemId, quantity });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async release(reservationId: string): Promise<StockReservation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ReservationRow>(
        `UPDATE stock_reservations SET status = 'RELEASED', released_at = now()
          WHERE reservation_id = $1 AND status = 'ACTIVE'
          RETURNING reservation_id, item_id, quantity, status`, [reservationId],
      );
      const reservation = result.rows[0];
      if (!reservation) {
        const exists = await client.query('SELECT 1 FROM stock_reservations WHERE reservation_id = $1', [reservationId]);
        if (!exists.rowCount) throw new DomainNotFoundError(`Stock reservation not found: ${reservationId}`);
        throw new DomainConflictError('Stock reservation has already been released', 'RESERVATION_ALREADY_RELEASED');
      }
      const updated = await client.query(
        `UPDATE inventory_items SET reserved_qty = reserved_qty - $2,
                version = version + 1, updated_at = now()
          WHERE item_id = $1 AND reserved_qty >= $2`, [reservation.item_id, reservation.quantity],
      );
      if (!updated.rowCount) throw new DomainValidationError('Reservation quantity exceeds current reserved inventory', 'INVENTORY_INVARIANT_BROKEN');
      await client.query('COMMIT');
      return StockReservation.create({ ...this.toReservationInput(reservation), status: 'RELEASED' });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private toItem(row: ItemRow): InventoryItem {
    return InventoryItem.create({ id: row.item_id, totalQty: row.total_qty, reservedQty: row.reserved_qty, version: row.version });
  }
  private toReservationInput(row: ReservationRow) {
    return { id: row.reservation_id, itemId: row.item_id, quantity: row.quantity };
  }
}

function sqlState(error: unknown, state: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === state;
}
