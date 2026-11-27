import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';
import { CurrentTenantId } from '../../shared/infrastructure/tenant/current-tenant.decorator.js';
import { TenantAuthGuard } from '../../shared/infrastructure/tenant/tenant-auth.guard.js';

@Controller('inventory')
@UseGuards(TenantAuthGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('items')
  createItem(@CurrentTenantId() tenantId: string, @Body() body: { id: string; totalQty: number }) {
    return this.inventory.createItem({ ...body, tenantId });
  }

  @Get('items/:id')
  getItem(@CurrentTenantId() tenantId: string, @Param('id') id: string) { return this.inventory.getItem(tenantId, id); }

  @Post('items/:id/reservations')
  reserve(@CurrentTenantId() tenantId: string, @Param('id') id: string, @Body('quantity', ParseIntPipe) quantity: number) {
    return this.inventory.reserve(tenantId, id, quantity);
  }

  @Post('reservations/:id/release')
  release(@CurrentTenantId() tenantId: string, @Param('id') id: string) { return this.inventory.release(tenantId, id); }
}
