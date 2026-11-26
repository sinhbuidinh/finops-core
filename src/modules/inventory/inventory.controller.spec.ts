import { InventoryController } from './inventory.controller.js';

describe('InventoryController', () => {
  const inventory = {
    createItem: vi.fn(), getItem: vi.fn(), reserve: vi.fn(), release: vi.fn(),
  };
  const controller = new InventoryController(inventory as never);

  beforeEach(() => vi.clearAllMocks());

  it('forwards each route operation to the service', () => {
    controller.createItem({ id: 'sku', totalQty: 2 });
    controller.getItem('sku');
    controller.reserve('sku', 1);
    controller.release('r1');
    expect(inventory.createItem).toHaveBeenCalledWith({ id: 'sku', totalQty: 2 });
    expect(inventory.getItem).toHaveBeenCalledWith('sku');
    expect(inventory.reserve).toHaveBeenCalledWith('sku', 1);
    expect(inventory.release).toHaveBeenCalledWith('r1');
  });
});
