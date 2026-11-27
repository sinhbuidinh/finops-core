import { InventoryController } from './inventory.controller.js';

describe('InventoryController', () => {
  const inventory = {
    createItem: vi.fn(), getItem: vi.fn(), reserve: vi.fn(), release: vi.fn(),
  };
  const controller = new InventoryController(inventory as never);

  beforeEach(() => vi.clearAllMocks());

  it('forwards each route operation to the service', () => {
    controller.createItem('tenant-1', { id: 'sku', totalQty: 2 });
    controller.getItem('tenant-1', 'sku');
    controller.reserve('tenant-1', 'sku', 1);
    controller.release('tenant-1', 'r1');
    expect(inventory.createItem).toHaveBeenCalledWith({ tenantId: 'tenant-1', id: 'sku', totalQty: 2 });
    expect(inventory.getItem).toHaveBeenCalledWith('tenant-1', 'sku');
    expect(inventory.reserve).toHaveBeenCalledWith('tenant-1', 'sku', 1);
    expect(inventory.release).toHaveBeenCalledWith('tenant-1', 'r1');
  });
});
