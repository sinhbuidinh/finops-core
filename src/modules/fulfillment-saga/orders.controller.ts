import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { FulfillmentSagaService } from './fulfillment-saga.service.js';
import type { FulfillmentContext } from './application/saga-steps.js';

@Controller('orders')
export class OrdersController {
  constructor(private readonly orders: FulfillmentSagaService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  create(@Headers('idempotency-key') key: string, @Body() body: {
    tenantId: string;
    inventoryItemId: string;
    quantity: number;
    payment: FulfillmentContext['payment'];
  }) {
    return this.orders.createOrder(body, key);
  }

  @Get(':id')
  get(@Param('id') id: string) { return this.orders.getOrder(id); }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(@Param('id') id: string, @Headers('idempotency-key') key: string) {
    return this.orders.cancelOrder(id, key);
  }
}
