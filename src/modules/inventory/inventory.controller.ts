import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { InventoryService } from './inventory.service.js';

@Controller('inventory')
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('items')
  createItem(@Body() body: { id: string; totalQty: number }) {
    return this.inventory.createItem(body);
  }

  @Get('items/:id')
  getItem(@Param('id') id: string) { return this.inventory.getItem(id); }

  @Post('items/:id/reservations')
  reserve(@Param('id') id: string, @Body('quantity', ParseIntPipe) quantity: number) {
    return this.inventory.reserve(id, quantity);
  }

  @Post('reservations/:id/release')
  release(@Param('id') id: string) { return this.inventory.release(id); }
}
