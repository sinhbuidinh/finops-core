import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { POSTGRES_POOL } from '../../../shared/infrastructure/database/database.module.js';
import type { Pool } from 'pg';
import { InventoryItem } from '../domain/inventory-item.js';
import { StockReservation } from '../domain/stock-reservation.js';
import type { InventoryRepositoryPort } from '../application/inventory-repository.port.js';

interface ItemRow { tenant_id: string; item_id: string; total_qty: number; reserved_qty: number; version: number; }
interface ReservationRow { reservation_id: string; tenant_id: string; item_id: string; quantity: number; status: 'ACTIVE' | 'RELEASED'; }

@Injectable()
export class PostgresInventoryRepository implements InventoryRepositoryPort {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async createItem(item: InventoryItem): Promise<InventoryItem> {
    try {
      const result = await this.pool.query<ItemRow>(
        `INSERT INTO inventory_items (tenant_id, item_id, total_qty) VALUES ($1, $2, $3)
         RETURNING tenant_id, item_id, total_qty, reserved_qty, version`, [item.tenantId, item.id, item.totalQty],
      );
      return this.toItem(result.rows[0]!);
    } catch (error) {
      if (sqlState(error, '23505')) throw new DomainConflictError(`Inventory item already exists for tenant ${item.tenantId}: ${item.id}`, 'INVENTORY_ITEM_EXISTS');
      throw error;
    }
  }

  async findItem(tenantId: string, itemId: string): Promise<InventoryItem | null> {
    const result = await this.pool.query<ItemRow>(
      'SELECT tenant_id, item_id, total_qty, reserved_qty, version FROM inventory_items WHERE tenant_id = $1 AND item_id = $2', [tenantId, itemId],
    );
    return result.rows[0] ? this.toItem(result.rows[0]) : null;
  }

  async reserve(tenantId: string, itemId: string, quantity: number, idempotencyKey?: string): Promise<StockReservation> {
    StockReservation.create({ id: 'validation', tenantId, itemId, quantity });
    const client = await this.pool.connect();
    const reservationId = randomUUID();
    try {
      await client.query('BEGIN');
      if (idempotencyKey) {
        const scopedIdempotencyKey = `${tenantId}:${idempotencyKey}`;
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [scopedIdempotencyKey]);
        const prior = await client.query<ReservationRow>(
          `SELECT reservation_id, tenant_id, item_id, quantity, status FROM stock_reservations WHERE tenant_id = $1 AND idempotency_key = $2 FOR UPDATE`, [tenantId, idempotencyKey],
        );
        const existing = prior.rows[0];
        if (existing) {
          if (existing.tenant_id !== tenantId || existing.item_id !== itemId || existing.quantity !== quantity) {
            throw new DomainConflictError('Reservation idempotency key was used with different inventory details', 'RESERVATION_IDEMPOTENCY_KEY_REUSED');
          }
          if (existing.status === 'ACTIVE') {
            await client.query('COMMIT');
            return StockReservation.create({ id: existing.reservation_id, tenantId, itemId, quantity });
          }
          const reactivated = await client.query(
            `UPDATE inventory_items SET reserved_qty = reserved_qty + $3, version = version + 1, updated_at = now()
              WHERE tenant_id = $1 AND item_id = $2 AND total_qty - reserved_qty >= $3 RETURNING item_id`, [tenantId, itemId, quantity],
          );
          if (!reactivated.rowCount) throw new DomainConflictError('Insufficient available inventory', 'INSUFFICIENT_INVENTORY');
          await client.query(`UPDATE stock_reservations SET status = 'ACTIVE', released_at = NULL WHERE reservation_id = $1 AND tenant_id = $2`, [existing.reservation_id, tenantId]);
          await client.query('COMMIT');
          return StockReservation.create({ id: existing.reservation_id, tenantId, itemId, quantity });
        }
      }
      const updated = await client.query(
        `UPDATE inventory_items SET reserved_qty = reserved_qty + $3, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND item_id = $2 AND total_qty - reserved_qty >= $3 RETURNING item_id`, [tenantId, itemId, quantity],
      );
      if (!updated.rowCount) {
        const exists = await client.query('SELECT 1 FROM inventory_items WHERE tenant_id = $1 AND item_id = $2', [tenantId, itemId]);
        if (!exists.rowCount) throw new DomainNotFoundError(`Inventory item not found for tenant ${tenantId}: ${itemId}`);
        throw new DomainConflictError('Insufficient available inventory', 'INSUFFICIENT_INVENTORY');
      }
      await client.query(
        `INSERT INTO stock_reservations (reservation_id, tenant_id, item_id, quantity, idempotency_key) VALUES ($1, $2, $3, $4, $5)`,
        [reservationId, tenantId, itemId, quantity, idempotencyKey ?? null],
      );
      await client.query('COMMIT');
      return StockReservation.create({ id: reservationId, tenantId, itemId, quantity });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async release(tenantId: string, reservationId: string): Promise<StockReservation> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<ReservationRow>(
        `UPDATE stock_reservations SET status = 'RELEASED', released_at = now()
          WHERE reservation_id = $1 AND tenant_id = $2 AND status = 'ACTIVE'
          RETURNING reservation_id, tenant_id, item_id, quantity, status`, [reservationId, tenantId],
      );
      const reservation = result.rows[0];
      if (!reservation) {
        const exists = await client.query<ReservationRow>(
          'SELECT reservation_id, tenant_id, item_id, quantity, status FROM stock_reservations WHERE reservation_id = $1 AND tenant_id = $2', [reservationId, tenantId],
        );
        const prior = exists.rows[0];
        if (!prior) throw new DomainNotFoundError(`Stock reservation not found: ${reservationId}`);
        await client.query('COMMIT');
        return StockReservation.create({ ...this.toReservationInput(prior), status: 'RELEASED' });
      }
      const updated = await client.query(
        `UPDATE inventory_items SET reserved_qty = reserved_qty - $3, version = version + 1, updated_at = now()
          WHERE tenant_id = $1 AND item_id = $2 AND reserved_qty >= $3`, [tenantId, reservation.item_id, reservation.quantity],
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
    return InventoryItem.create({ tenantId: row.tenant_id, id: row.item_id, totalQty: row.total_qty, reservedQty: row.reserved_qty, version: row.version });
  }
  private toReservationInput(row: ReservationRow) {
    return { id: row.reservation_id, tenantId: row.tenant_id, itemId: row.item_id, quantity: row.quantity };
  }
}

function sqlState(error: unknown, state: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === state;
}
