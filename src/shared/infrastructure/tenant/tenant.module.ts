import { Global, MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { OrdersController } from '../../../modules/fulfillment-saga/orders.controller.js';
import { InventoryController } from '../../../modules/inventory/inventory.controller.js';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { TenantContextMiddleware } from './tenant-context.middleware.js';
import { TenantContext } from './tenant-context.js';
import { AuthController } from './auth.controller.js';
import { LoginService } from './login.service.js';
import { AuthUserRepository } from './auth-user.repository.js';
import { UserManagementService } from './user-management.service.js';
import { SuperAdminGuard } from './super-admin.guard.js';
import { TenantAdminGuard } from './tenant-admin.guard.js';

@Global()
@Module({
  controllers: [AuthController],
  providers: [TenantContext, TenantAuthGuard, TenantContextMiddleware, AuthUserRepository, LoginService, UserManagementService, SuperAdminGuard, TenantAdminGuard],
  exports: [TenantContext, TenantAuthGuard, AuthUserRepository],
})
export class TenantModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes(InventoryController, OrdersController);
  }
}
