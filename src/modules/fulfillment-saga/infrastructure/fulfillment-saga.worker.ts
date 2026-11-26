import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../../../shared/infrastructure/database/database.module.js';
import type { FulfillmentContext } from '../application/saga-steps.js';
import { FulfillmentSaga } from '../application/fulfillment-saga.js';

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
    const client = await this.pool.connect();
    let row: { saga_id: string; order_id: string; payload: FulfillmentContext; attempts: number } | undefined;
    try {
      await client.query('BEGIN');
      const claimed = await client.query<{ saga_id: string; order_id: string; payload: FulfillmentContext; attempts: number }>(
        `SELECT saga_id, order_id, payload, attempts FROM fulfillment_saga_jobs
          WHERE (state = 'PENDING' AND available_at <= now())
             OR (state = 'RUNNING' AND locked_at <= now() - interval '60 seconds')
          ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      );
      row = claimed.rows[0];
      if (!row) { await client.query('COMMIT'); return; }
      await client.query(`UPDATE fulfillment_saga_jobs SET state = 'RUNNING', attempts = attempts + 1, locked_at = now() WHERE saga_id = $1`, [row.saga_id]);
      await client.query('COMMIT');
      await this.saga.execute({ ...row.payload, sagaId: row.saga_id });
      await this.finish(row.saga_id, row.order_id, 'COMPLETED', { sagaId: row.saga_id, orderId: row.order_id });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (row) {
        const maxAttempts = Number(process.env.SAGA_MAX_ATTEMPTS ?? 5);
        const terminal = row.attempts + 1 >= maxAttempts;
        const delay = Math.min(300_000, 1000 * 2 ** row.attempts);
        await this.pool.query(
          `UPDATE fulfillment_saga_jobs SET state = $2, locked_at = NULL, available_at = now() + ($3 * interval '1 millisecond'), last_error = $4
            WHERE saga_id = $1`, [row.saga_id, terminal ? 'FAILED' : 'PENDING', delay, error instanceof Error ? error.message.slice(0, 4000) : String(error).slice(0, 4000)],
        );
        if (terminal) await this.finish(row.saga_id, row.order_id, 'FAILED', { sagaId: row.saga_id, orderId: row.order_id, error: error instanceof Error ? error.message : String(error) });
      }
    } finally { client.release(); this.busy = false; }
  }

  private async finish(sagaId: string, orderId: string, state: 'COMPLETED' | 'FAILED', payload: Record<string, unknown>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE fulfillment_saga_jobs SET state = $2, locked_at = NULL, completed_at = now() WHERE saga_id = $1`, [sagaId, state]);
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
