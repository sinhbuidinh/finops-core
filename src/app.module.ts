import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { HealthController } from './health.controller.js';
import { IdempotencyModule } from './shared/infrastructure/idempotency/idempotency.module.js';
import { OutboxModule } from './shared/infrastructure/outbox/outbox.module.js';
import { DatabaseModule } from './shared/infrastructure/database/database.module.js';
import { LedgerModule } from './modules/ledger/ledger.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { FulfillmentSagaModule } from './modules/fulfillment-saga/fulfillment-saga.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    DatabaseModule,
    IdempotencyModule,
    OutboxModule,
    LedgerModule,
    InventoryModule,
    FulfillmentSagaModule,
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com,
    // then run `npx @nestjs/observe link` to write your key pair into .env.
    ObserveModule.forRoot({
      appKey: process.env.OBSERVE_APP_KEY ?? 'YOUR_APP_KEY',
      appSecret: process.env.OBSERVE_APP_SECRET ?? 'YOUR_APP_SECRET',
      serviceId: 'app',
    }),
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
