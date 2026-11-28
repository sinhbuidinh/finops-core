import type { MiddlewareConsumer } from '@nestjs/common';
import { OrdersController } from '../../../modules/fulfillment-saga/orders.controller.js';
import { LedgerController } from '../../../modules/ledger/ledger.controller.js';
import { InventoryController } from '../../../modules/inventory/inventory.controller.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import { TenantModule } from './tenant.module.js';

describe('TenantModule', () => {
  it('registers tenant context middleware for inventory and order controllers', () => {
    const consumer = { apply: vi.fn().mockReturnThis(), forRoutes: vi.fn() };
    new TenantModule().configure(consumer as unknown as MiddlewareConsumer);
    expect(consumer.apply).toHaveBeenCalledWith(TenantContextMiddleware);
    expect(consumer.forRoutes).toHaveBeenCalledWith(InventoryController, OrdersController, LedgerController);
  });
});
