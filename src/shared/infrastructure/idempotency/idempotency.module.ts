import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { IdempotencyCleanupWorker } from './idempotency-cleanup.worker.js';
import { IdempotencyStore } from './idempotency-store.js';

@Module({
  imports: [DatabaseModule],
  providers: [IdempotencyStore, IdempotencyCleanupWorker],
  exports: [IdempotencyStore],
})
export class IdempotencyModule {}
