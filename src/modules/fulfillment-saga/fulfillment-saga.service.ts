import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../../shared/infrastructure/database/database.module.js';
import { IdempotencyStore, type IdempotencyKeyInput } from '../../shared/infrastructure/idempotency/idempotency-store.js';
import type { FulfillmentContext } from './application/saga-steps.js';
import { OrderState } from './domain/order-state-machine.js';

@Injectable()
export class FulfillmentSagaService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool, private readonly idempotency: IdempotencyStore) {}

  async createOrder(input: { tenantId: string; inventoryItemId: string; quantity: number; payment: FulfillmentContext['payment'] }, key: string) {
    if (!key?.trim()) throw new BadRequestException('Idempotency-Key header is required');
    if (!input.tenantId?.trim() || !input.inventoryItemId?.trim() || !Number.isInteger(input.quantity) || input.quantity <= 0 || !input.payment?.id || !Array.isArray(input.payment.lines)) {
      throw new BadRequestException('Invalid order payload');
    }
    const id = randomUUID();
    const sagaId = randomUUID();
    const response = { id, tenantId: input.tenantId, state: OrderState.APPROVED, sagaId };
    const idem = this.key('orders:create', key, JSON.stringify(input));
    const claim = await this.idempotency.acquire(idem);
    if (claim.kind === 'completed') return claim.responseBody;
    if (claim.kind === 'in_progress') throw new ConflictException('Request with this Idempotency-Key is in progress');
    if (claim.kind === 'key_reused') throw new ConflictException('Idempotency-Key was already used with a different request');
    try {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`INSERT INTO fulfillment_orders (id, tenant_id, state, saga_id, payload) VALUES ($1, $2, $5, $3, $4)`, [id, input.tenantId, sagaId, input, OrderState.APPROVED]);
        await client.query(`INSERT INTO fulfillment_saga_jobs (saga_id, order_id, payload) VALUES ($1, $2, $3)`, [sagaId, id, { ...input, orderId: id, sagaId }]);
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
      await this.idempotency.complete(idem, claim.ownerToken, 202, response);
      return response;
    } catch (error) { await this.idempotency.release(idem, claim.ownerToken).catch(() => undefined); throw error; }
  }

  async getOrder(id: string) {
    const result = await this.pool.query<{ id: string; tenant_id: string; state: string; saga_id: string; created_at: Date }>(
      'SELECT id, tenant_id, state, saga_id, created_at FROM fulfillment_orders WHERE id = $1', [id],
    );
    const order = result.rows[0];
    if (!order) throw new NotFoundException('Order not found');
    return { id: order.id, tenantId: order.tenant_id, state: order.state, sagaId: order.saga_id, createdAt: order.created_at };
  }

  async cancelOrder(id: string, key: string) {
    if (!key?.trim()) throw new BadRequestException('Idempotency-Key header is required');
    const idem = this.key(`orders:${id}:cancel`, key, id);
    const claim = await this.idempotency.acquire(idem);
    if (claim.kind === 'completed') return claim.responseBody;
    if (claim.kind === 'in_progress') throw new ConflictException('Request with this Idempotency-Key is in progress');
    if (claim.kind === 'key_reused') throw new ConflictException('Idempotency-Key was already used with a different request');
    try {
      const client = await this.pool.connect();
      let response: { id: string; state: string };
      try {
        await client.query('BEGIN');
        const result = await client.query<{ id: string; state: string; saga_id: string }>(`SELECT id, state, saga_id FROM fulfillment_orders WHERE id = $1 FOR UPDATE`, [id]);
        const order = result.rows[0];
        if (!order) throw new NotFoundException('Order not found');
        if (order.state !== OrderState.APPROVED) throw new ConflictException(`Order cannot be cancelled from ${order.state}`);
        await client.query(`UPDATE fulfillment_orders SET state = $2, updated_at = now() WHERE id = $1`, [id, OrderState.CANCELLED]);
        await client.query(`UPDATE fulfillment_saga_jobs SET state = 'FAILED', last_error = 'Order cancelled', completed_at = now() WHERE saga_id = $1 AND state = 'PENDING'`, [order.saga_id]);
        response = { id, state: OrderState.CANCELLED };
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
      finally { client.release(); }
      await this.idempotency.complete(idem, claim.ownerToken, 200, response);
      return response;
    } catch (error) { await this.idempotency.release(idem, claim.ownerToken).catch(() => undefined); throw error; }
  }

  private key(scope: string, key: string, fingerprintPayload: string): IdempotencyKeyInput {
    return { scope, key, fingerprint: `${scope}:${fingerprintPayload}` };
  }

  async start(input: Omit<FulfillmentContext, 'sagaId'> & { sagaId?: string }): Promise<{ sagaId: string }> {
    const sagaId = input.sagaId ?? randomUUID();
    await this.pool.query(
      `INSERT INTO fulfillment_saga_jobs (saga_id, order_id, payload)
       VALUES ($1, $2, $3) ON CONFLICT (saga_id) DO NOTHING`,
      [sagaId, input.orderId, { ...input, sagaId }],
    );
    return { sagaId };
  }
}
