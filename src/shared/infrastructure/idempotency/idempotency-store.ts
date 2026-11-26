import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../database/database.module.js';

export type IdempotencyAcquireResult =
  | { readonly kind: 'acquired'; readonly ownerToken: string }
  | { readonly kind: 'in_progress'; readonly leaseExpiresAt: Date }
  | {
      readonly kind: 'completed';
      readonly responseStatus: number;
      readonly responseBody: unknown;
    }
  | { readonly kind: 'key_reused' };

export interface IdempotencyKeyInput {
  readonly scope: string;
  readonly key: string;
  readonly fingerprint: string;
}

@Injectable()
export class IdempotencyStore {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async acquire(
    input: IdempotencyKeyInput,
    options: { ttlMs?: number; leaseMs?: number } = {},
  ): Promise<IdempotencyAcquireResult> {
    const ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    const leaseMs = options.leaseMs ?? 60_000;
    const ownerToken = randomUUID();
    const inserted = await this.pool.query<{ owner_token: string }>(
      `INSERT INTO idempotency_keys
         (scope, key, fingerprint, state, owner_token, lease_expires_at, expires_at)
       VALUES ($1, $2, $3, 'IN_PROGRESS', $4, now() + ($5 * interval '1 millisecond'),
         now() + ($6 * interval '1 millisecond'))
       ON CONFLICT (scope, key) DO UPDATE SET
         fingerprint = EXCLUDED.fingerprint,
         state = 'IN_PROGRESS',
         owner_token = EXCLUDED.owner_token,
         response_status = NULL,
         response_body = NULL,
         lease_expires_at = EXCLUDED.lease_expires_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = now()
       WHERE idempotency_keys.expires_at <= now()
          OR (idempotency_keys.state = 'IN_PROGRESS'
              AND idempotency_keys.lease_expires_at <= now())
       RETURNING owner_token`,
      [input.scope, input.key, input.fingerprint, ownerToken, leaseMs, ttlMs],
    );

    if (inserted.rowCount) {
      return { kind: 'acquired', ownerToken };
    }

    const existing = await this.pool.query<{
      fingerprint: string;
      state: 'IN_PROGRESS' | 'COMPLETED';
      lease_expires_at: Date | null;
      response_status: number | null;
      response_body: unknown;
    }>(
      `SELECT fingerprint, state, lease_expires_at, response_status, response_body
         FROM idempotency_keys WHERE scope = $1 AND key = $2`,
      [input.scope, input.key],
    );
    const record = existing.rows[0];

    // The conflicting row could expire between the upsert and this read.
    if (!record) return this.acquire(input, options);
    if (record.fingerprint !== input.fingerprint) return { kind: 'key_reused' };
    if (record.state === 'COMPLETED') {
      return {
        kind: 'completed',
        responseStatus: record.response_status!,
        responseBody: record.response_body,
      };
    }

    return { kind: 'in_progress', leaseExpiresAt: record.lease_expires_at! };
  }

  async complete(
    input: IdempotencyKeyInput,
    ownerToken: string,
    responseStatus: number,
    responseBody: unknown,
    ttlMs = 24 * 60 * 60 * 1000,
  ): Promise<void> {
    const result = await this.pool.query(
      `UPDATE idempotency_keys
          SET state = 'COMPLETED', owner_token = NULL, lease_expires_at = NULL,
              response_status = $4, response_body = $5,
              expires_at = now() + ($6 * interval '1 millisecond'), updated_at = now()
        WHERE scope = $1 AND key = $2 AND fingerprint = $3
          AND state = 'IN_PROGRESS' AND owner_token = $7`,
      [
        input.scope,
        input.key,
        input.fingerprint,
        responseStatus,
        responseBody,
        ttlMs,
        ownerToken,
      ],
    );
    if (!result.rowCount)
      throw new Error('Idempotency claim was lost before completion');
  }

  async release(input: IdempotencyKeyInput, ownerToken: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM idempotency_keys
        WHERE scope = $1 AND key = $2 AND fingerprint = $3
          AND state = 'IN_PROGRESS' AND owner_token = $4`,
      [input.scope, input.key, input.fingerprint, ownerToken],
    );
  }

  async purgeExpired(limit = 1000): Promise<number> {
    const result = await this.pool.query(
      `WITH expired AS (
         SELECT ctid FROM idempotency_keys WHERE expires_at <= now() LIMIT $1
       ) DELETE FROM idempotency_keys keys USING expired
          WHERE keys.ctid = expired.ctid`,
      [limit],
    );
    return result.rowCount ?? 0;
  }
}
