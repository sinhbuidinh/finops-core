import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('items')
  createItem(@Body() body: { tenantId: string; id: string; totalQty: number }) {
    return this.inventory.createItem(body);
  }

  @Get('tenants/:tenantId/items/:id')
  getItem(@Param('tenantId') tenantId: string, @Param('id') id: string) { return this.inventory.getItem(tenantId, id); }

  @Post('tenants/:tenantId/items/:id/reservations')
  reserve(@Param('tenantId') tenantId: string, @Param('id') id: string, @Body('quantity', ParseIntPipe) quantity: number) {
    return this.inventory.reserve(tenantId, id, quantity);
  }

  @Post('tenants/:tenantId/reservations/:id/release')
  release(@Param('tenantId') tenantId: string, @Param('id') id: string) { return this.inventory.release(tenantId, id); }
}
