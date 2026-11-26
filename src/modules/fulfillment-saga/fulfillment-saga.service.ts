import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from '../../shared/infrastructure/database/database.module.js';
import type { FulfillmentContext } from './application/saga-steps.js';

@Injectable()
export class FulfillmentSagaService {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

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
