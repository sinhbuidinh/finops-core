import { Module } from '@nestjs/common';
import { InventoryModule } from '../inventory/inventory.module.js';
import { LedgerModule } from '../ledger/ledger.module.js';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module.js';
import { FulfillmentSaga } from './application/fulfillment-saga.js';
import { LEDGER_POSTING_PORT } from './application/ledger-posting.port.js';
import { ReleaseInventoryStep, ReserveInventoryStep, ReverseLedgerEntryStep, SettleLedgerPaymentStep } from './application/saga-steps.js';
import { FulfillmentSagaService } from './fulfillment-saga.service.js';
import { LedgerPostingAdapter } from './infrastructure/ledger-posting.adapter.js';
import { FulfillmentSagaWorker } from './infrastructure/fulfillment-saga.worker.js';
import { InventoryService } from '../inventory/inventory.service.js';
import { IdempotencyModule } from '../../shared/infrastructure/idempotency/idempotency.module.js';
import { OrdersController } from './orders.controller.js';

@Module({
  imports: [DatabaseModule, InventoryModule, LedgerModule, IdempotencyModule],
  controllers: [OrdersController],
  providers: [
    LedgerPostingAdapter,
    { provide: LEDGER_POSTING_PORT, useExisting: LedgerPostingAdapter },
    {
      provide: FulfillmentSaga,
      useFactory: (inventory: InventoryService, ledger: LedgerPostingAdapter) =>
        new FulfillmentSaga([new ReserveInventoryStep(inventory), new SettleLedgerPaymentStep(ledger)]),
      inject: [InventoryService, LEDGER_POSTING_PORT],
    },
    // Explicit compensators are exported for flows that need to run rollback independently.
    { provide: ReleaseInventoryStep, useFactory: (inventory: InventoryService) => new ReleaseInventoryStep(inventory), inject: [InventoryService] },
    { provide: ReverseLedgerEntryStep, useFactory: (ledger: LedgerPostingAdapter) => new ReverseLedgerEntryStep(ledger), inject: [LEDGER_POSTING_PORT] },
    FulfillmentSagaService,
    FulfillmentSagaWorker,
  ],
  exports: [FulfillmentSagaService, FulfillmentSaga, LEDGER_POSTING_PORT],
})
export class FulfillmentSagaModule {}
