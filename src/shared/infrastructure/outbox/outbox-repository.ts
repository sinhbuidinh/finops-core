import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from '../database/database.module.js';

export interface OutboxMessage {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly attempts: number;
  readonly claimToken: string;
}

export interface EnqueueOutboxMessage {
  readonly eventId: string;
  readonly aggregateId: string;
  readonly eventName: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export interface OutboxRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

@Injectable()
export class OutboxRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  /** Pass the caller's transaction client so the event commits with domain state. */
  async enqueue(
    transaction: PoolClient,
    message: EnqueueOutboxMessage,
  ): Promise<void> {
    await transaction.query(
      `INSERT INTO outbox_events (event_id, aggregate_id, event_name, payload, occurred_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        message.eventId,
        message.aggregateId,
        message.eventName,
        message.payload,
        message.occurredAt,
      ],
    );
  }

  async claimBatch(
    batchSize: number,
    leaseMs: number,
    policy: OutboxRetryPolicy,
  ): Promise<OutboxMessage[]> {
    await this.pool.query(
      `UPDATE outbox_events
          SET state = 'DEAD_LETTER', locked_at = NULL, locked_by = NULL,
              last_error = COALESCE(last_error, 'Maximum delivery attempts exceeded')
        WHERE state = 'PROCESSING' AND attempts >= $1
          AND locked_at <= now() - ($2 * interval '1 millisecond')`,
      [policy.maxAttempts, leaseMs],
    );

    const result = await this.pool.query<{
      event_id: string;
      aggregate_id: string;
      event_name: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
      attempts: number;
      locked_by: string;
    }>(
      `WITH ready AS (
         SELECT event_id FROM outbox_events
          WHERE attempts < $3
            AND ((state = 'PENDING' AND available_at <= now())
              OR (state = 'PROCESSING'
                AND locked_at <= now() - ($2 * interval '1 millisecond')))
          ORDER BY available_at, created_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE outbox_events AS event
          SET state = 'PROCESSING', attempts = event.attempts + 1,
              locked_at = now(), locked_by = gen_random_uuid()
         FROM ready
        WHERE event.event_id = ready.event_id
       RETURNING event.event_id, event.aggregate_id, event.event_name,
                 event.payload, event.occurred_at, event.attempts, event.locked_by`,
      [batchSize, leaseMs, policy.maxAttempts],
    );

    return result.rows.map((row) => ({
      eventId: row.event_id,
      aggregateId: row.aggregate_id,
      eventName: row.event_name,
      payload: row.payload,
      occurredAt: row.occurred_at,
      attempts: row.attempts,
      claimToken: row.locked_by,
    }));
  }

  async markPublished(eventId: string, claimToken: string): Promise<void> {
    await this.pool.query(
      `UPDATE outbox_events
          SET state = 'PUBLISHED', published_at = now(), locked_at = NULL,
              locked_by = NULL, last_error = NULL
        WHERE event_id = $1 AND state = 'PROCESSING' AND locked_by = $2`,
      [eventId, claimToken],
    );
  }

  async markFailed(
    event: OutboxMessage,
    claimToken: string,
    error: unknown,
    policy: OutboxRetryPolicy,
  ): Promise<void> {
    const delayMs = Math.min(
      policy.maxDelayMs,
      policy.baseDelayMs * 2 ** Math.max(0, event.attempts - 1),
    );
    const message = error instanceof Error ? error.message : String(error);
    await this.pool.query(
      `UPDATE outbox_events
          SET state = CASE WHEN attempts >= $3 THEN 'DEAD_LETTER' ELSE 'PENDING' END,
              available_at = now() + ($4 * interval '1 millisecond'),
              locked_at = NULL, locked_by = NULL, last_error = $5
        WHERE event_id = $1 AND state = 'PROCESSING' AND locked_by = $2`,
      [
        event.eventId,
        claimToken,
        policy.maxAttempts,
        delayMs,
        message.slice(0, 4000),
      ],
    );
  }
}
