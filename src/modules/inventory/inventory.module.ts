import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module.js';
import { INVENTORY_REPOSITORY } from './application/inventory-repository.port.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { PostgresInventoryRepository } from './infrastructure/postgres-inventory.repository.js';

@Module({
  imports: [DatabaseModule],
  controllers: [InventoryController],
  providers: [PostgresInventoryRepository, { provide: INVENTORY_REPOSITORY, useExisting: PostgresInventoryRepository }, InventoryService],
  exports: [InventoryService, PostgresInventoryRepository],
})
export class InventoryModule {}
