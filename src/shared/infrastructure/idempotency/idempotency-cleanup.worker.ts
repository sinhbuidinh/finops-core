import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { IdempotencyStore } from './idempotency-store.js';

@Injectable()
export class IdempotencyCleanupWorker implements OnModuleInit, OnModuleDestroy {
  private interval?: NodeJS.Timeout;

  constructor(private readonly store: IdempotencyStore) {}

  onModuleInit(): void {
    this.interval = setInterval(() => {
      void this.store.purgeExpired().catch(() => undefined);
    }, 60_000);
    this.interval.unref();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }
}
