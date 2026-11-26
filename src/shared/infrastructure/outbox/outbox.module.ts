import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module.js';
import { OutboxEventBus } from './outbox-event-bus.js';
import { OutboxRelayWorker } from './outbox-relay.worker.js';
import { OutboxRepository } from './outbox-repository.js';

@Module({
  imports: [DatabaseModule],
  providers: [OutboxEventBus, OutboxRepository, OutboxRelayWorker],
  exports: [OutboxEventBus, OutboxRepository],
})
export class OutboxModule {}
