import { Global, MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { OrdersController } from '../../../modules/fulfillment-saga/orders.controller.js';
import { InventoryController } from '../../../modules/inventory/inventory.controller.js';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import { TenantContext } from './tenant-context.js';

@Global()
@Module({
  providers: [TenantContext, TenantAuthGuard, TenantContextMiddleware],
  exports: [TenantContext, TenantAuthGuard],
})
export class TenantModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes(InventoryController, OrdersController);
  }
}
