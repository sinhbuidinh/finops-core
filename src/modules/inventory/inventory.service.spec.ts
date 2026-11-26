import { Test } from '@nestjs/testing';
import { INVENTORY_REPOSITORY } from './application/inventory-repository.port.js';
import { InventoryItem } from './domain/inventory-item.js';
import { InventoryService } from './inventory.service.js';

describe('InventoryService', () => {
  const repository = {
    createItem: vi.fn(), findItem: vi.fn(), reserve: vi.fn(), release: vi.fn(),
  };
  let service: InventoryService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [InventoryService, { provide: INVENTORY_REPOSITORY, useValue: repository }],
    }).compile();
    service = module.get(InventoryService);
  });

  it('delegates each operation to the use case', async () => {
    const item = InventoryItem.create({ id: 'sku', totalQty: 4 });
    repository.createItem.mockResolvedValue(item);
    repository.findItem.mockResolvedValue(item);
    repository.reserve.mockResolvedValue({ id: 'r', itemId: 'sku', quantity: 1 });
    repository.release.mockResolvedValue({ id: 'r', itemId: 'sku', quantity: 1 });
    await expect(service.createItem({ id: 'sku', totalQty: 4 })).resolves.toBe(item);
    await expect(service.getItem('sku')).resolves.toBe(item);
    await expect(service.reserve('sku', 1)).resolves.toMatchObject({ id: 'r' });
    await expect(service.release('r')).resolves.toMatchObject({ id: 'r' });
    expect(repository.findItem).toHaveBeenCalledWith('sku');
    expect(repository.reserve).toHaveBeenCalledWith('sku', 1, undefined);
    expect(repository.release).toHaveBeenCalledWith('r');
  });
});
