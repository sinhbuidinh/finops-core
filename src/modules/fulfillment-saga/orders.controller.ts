import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { FulfillmentSagaService } from './fulfillment-saga.service.js';
import type { FulfillmentContext } from './application/saga-steps.js';
import { CurrentTenantId } from '../../shared/infrastructure/tenant/current-tenant.decorator.js';
import { TenantAuthGuard } from '../../shared/infrastructure/tenant/tenant-auth.guard.js';

@Controller('orders')
@UseGuards(TenantAuthGuard)
export class OrdersController {
  constructor(private readonly orders: FulfillmentSagaService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@CurrentTenantId() tenantId: string, @Headers('idempotency-key') key: string, @Body() body: {
    inventoryItemId: string;
    quantity: number;
    payment: FulfillmentContext['payment'];
  }) {
    return this.orders.createOrder({ ...body, tenantId }, key);
  }

  @Get(':id')
  get(@CurrentTenantId() tenantId: string, @Param('id') id: string) { return this.orders.getOrder(tenantId, id); }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Headers('idempotency-key') key: string) {
    return this.orders.cancelOrder(tenantId, id, key);
  }
}
