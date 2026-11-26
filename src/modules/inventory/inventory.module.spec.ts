import { MODULE_METADATA } from '@nestjs/common/constants';
import { InventoryModule } from './inventory.module.js';
import { InventoryController } from './inventory.controller.js';
import { InventoryService } from './inventory.service.js';
import { PostgresInventoryRepository } from './infrastructure/postgres-inventory.repository.js';

describe('InventoryModule', () => {
  it('registers the inventory adapter, controller, service and repository port binding', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, InventoryModule)).toContain(InventoryController);
    expect(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, InventoryModule)).toEqual(expect.arrayContaining([
      PostgresInventoryRepository,
      InventoryService,
      expect.objectContaining({ provide: expect.anything(), useExisting: PostgresInventoryRepository }),
    ]));
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, InventoryModule)).toEqual(
      expect.arrayContaining([InventoryService, PostgresInventoryRepository]),
    );
  });
});
