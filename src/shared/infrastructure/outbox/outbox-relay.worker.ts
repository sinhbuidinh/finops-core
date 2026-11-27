import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { LoggerService } from '@nestjs/common';
import { StructuredLogger } from '../../../common/structured-logger.js';
import { OutboxEventBus } from './outbox-event-bus.js';
import {
  OutboxRepository,
  type OutboxMessage,
  type OutboxRetryPolicy,
} from './outbox-repository.js';

const RETRY_POLICY: OutboxRetryPolicy = {
  // The first delivery is attempt one; after three total attempts the event is
  // moved to DEAD_LETTER. Override with OUTBOX_MAX_ATTEMPTS when needed.
  maxAttempts: Number(process.env.OUTBOX_MAX_ATTEMPTS ?? 3),
  baseDelayMs: Number(process.env.OUTBOX_RETRY_BASE_MS ?? 1000),
  maxDelayMs: Number(process.env.OUTBOX_RETRY_MAX_MS ?? 300_000),
};

@Injectable()
export class OutboxRelayWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger: LoggerService = new StructuredLogger();
  private interval?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: OutboxRepository,
    private readonly eventBus: OutboxEventBus,
  ) {}

  onModuleInit(): void {
    const pollMs = Number(process.env.OUTBOX_POLL_INTERVAL_MS ?? 1000);
    this.interval = setInterval(() => void this.runOnce(), pollMs);
    this.interval.unref();
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const batch = await this.repository.claimBatch(
        Number(process.env.OUTBOX_BATCH_SIZE ?? 20),
        Number(process.env.OUTBOX_LEASE_MS ?? 30_000),
        RETRY_POLICY,
      );
      await Promise.all(batch.map((event) => this.deliver(event)));
    } catch (error) {
      this.logger.error('Outbox relay poll failed', error);
    } finally {
      this.running = false;
    }
  }

  private async deliver(event: OutboxMessage): Promise<void> {
    try {
      await this.eventBus.publish(event);
      await this.repository.markPublished(event.eventId, event.claimToken);
    } catch (error) {
      try {
        await this.repository.markFailed(
          event,
          event.claimToken,
          error,
          RETRY_POLICY,
        );
      } catch (updateError) {
        this.logger.error(
          'Could not record outbox delivery failure',
          updateError,
          event.eventId,
        );
      }
      this.logger.warn('Outbox event delivery failed', error, event.eventId);
    }
  }
}
