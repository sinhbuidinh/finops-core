import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from '../../../shared/infrastructure/database/database.module.js';
import type { FulfillmentContext } from '../application/saga-steps.js';
import { FulfillmentSaga } from '../application/fulfillment-saga.js';
import { OrderState } from '../domain/order-state-machine.js';

const SagaJobState = { PENDING: 'PENDING', RUNNING: 'RUNNING', COMPLETED: 'COMPLETED', FAILED: 'FAILED' } as const;

@Injectable()
export class FulfillmentSagaWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private busy = false;
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool, private readonly saga: FulfillmentSaga) {}
  onModuleInit(): void {
    this.timer = setInterval(() => void this.runOnce(), Number(process.env.SAGA_POLL_INTERVAL_MS ?? 1000));
    this.timer.unref();
    void this.runOnce();
  }
  onModuleDestroy(): void { if (this.timer) clearInterval(this.timer); }

  async runOnce(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    let client: PoolClient | undefined;
    let row: { saga_id: string; order_id: string; payload: FulfillmentContext; attempts: number } | undefined;
    try {
      client = await this.pool.connect();
      const db = client;
      await db.query('BEGIN');
      const claimed = await db.query<{ saga_id: string; order_id: string; payload: FulfillmentContext; attempts: number }>(
        `SELECT saga_id, order_id, payload, attempts FROM fulfillment_saga_jobs
          WHERE (state = 'PENDING' AND available_at <= now())
             OR (state = 'RUNNING' AND locked_at <= now() - interval '60 seconds')
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      row = claimed.rows[0];
      if (!row) { await db.query('COMMIT'); return; }
      await db.query(`UPDATE fulfillment_saga_jobs SET state = 'RUNNING', attempts = attempts + 1, locked_at = now() WHERE saga_id = $1`, [row.saga_id]);
      await db.query(`UPDATE fulfillment_orders SET state = $2, updated_at = now() WHERE id = $1 AND state = $3`, [row.order_id, OrderState.RESERVING_STOCK, OrderState.APPROVED]);
      await db.query('COMMIT');
      await this.saga.execute({
        ...row.payload,
        sagaId: row.saga_id,
        onPaymentStarting: async () => {
          const changed = await this.pool.query(
            `UPDATE fulfillment_orders SET state = $2, updated_at = now()
              WHERE id = $1 AND state IN ($3, $2)`, [row!.order_id, OrderState.SETTLING_PAYMENT, OrderState.RESERVING_STOCK],
          );
          if (!changed.rowCount) throw new Error('Order is no longer available for payment settlement');
        },
      });
      await this.finish(row.saga_id, row.order_id, SagaJobState.COMPLETED, { sagaId: row.saga_id, orderId: row.order_id });
    } catch (error) {
      await client?.query('ROLLBACK').catch(() => undefined);
      if (row) {
        const maxAttempts = Number(process.env.SAGA_MAX_ATTEMPTS ?? 5);
        const compensationFailed = error instanceof AggregateError;
        const terminal = !compensationFailed && row.attempts + 1 >= maxAttempts;
        const delay = Math.min(300_000, 1000 * 2 ** row.attempts);
        const message = error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000);
        if (terminal) {
          await this.finish(row.saga_id, row.order_id, SagaJobState.FAILED, { sagaId: row.saga_id, orderId: row.order_id, error: error instanceof Error ? error.message : String(error) });
        } else {
          await this.pool.query(
            `UPDATE fulfillment_saga_jobs SET state = 'PENDING', locked_at = NULL, available_at = now() + ($2 * interval '1 millisecond'), last_error = $3
              WHERE saga_id = $1 AND state = 'RUNNING'`, [row.saga_id, delay, message],
          );
        }
      }
    } finally { client?.release(); this.busy = false; }
  }

  private async finish(sagaId: string, orderId: string, state: typeof SagaJobState.COMPLETED | typeof SagaJobState.FAILED, payload: Record<string, unknown>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE fulfillment_saga_jobs SET state = $2, locked_at = NULL, completed_at = now() WHERE saga_id = $1`, [sagaId, state]);
      const orderState = state === SagaJobState.COMPLETED ? OrderState.CONFIRMED : OrderState.FAILED;
      const allowedStates = state === SagaJobState.COMPLETED
        ? [OrderState.SETTLING_PAYMENT, OrderState.CONFIRMED]
        : [OrderState.RESERVING_STOCK, OrderState.SETTLING_PAYMENT, OrderState.FAILED];
      const order = await client.query(
        `UPDATE fulfillment_orders SET state = $2, updated_at = now() WHERE id = $1 AND state = ANY($3::text[])`,
        [orderId, orderState, allowedStates],
      );
      if (!order.rowCount) throw new Error(`Order ${orderId} cannot be marked ${orderState}`);
      await client.query(
        `INSERT INTO outbox_events (event_id, aggregate_id, event_name, payload, occurred_at)
         VALUES ($1, $2, $3, $4, now()) ON CONFLICT (event_id) DO NOTHING`,
        [randomUUID(), orderId, `FulfillmentSaga${state}`, payload],
      );
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}
