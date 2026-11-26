import { DomainNotFoundError } from '../../../shared/domain/domain-error.js';
import { InventoryItem } from '../domain/inventory-item.js';
import { StockReservation } from '../domain/stock-reservation.js';
import { InventoryUseCase } from './inventory.use-case.js';
import type { InventoryRepositoryPort } from './inventory-repository.port.js';

describe('InventoryUseCase', () => {
  const item = InventoryItem.create({ id: 'sku', totalQty: 8 });
  const reservation = StockReservation.create({ id: 'r1', itemId: 'sku', quantity: 2 });
  const repository: InventoryRepositoryPort = {
    createItem: vi.fn().mockResolvedValue(item), findItem: vi.fn().mockResolvedValue(item),
    reserve: vi.fn().mockResolvedValue(reservation), release: vi.fn().mockResolvedValue(reservation),
  };
  const useCase = new InventoryUseCase(repository);

  beforeEach(() => vi.clearAllMocks());

  it('creates a validated item through the repository', async () => {
    await expect(useCase.createItem({ id: 'sku', totalQty: 8 })).resolves.toBe(item);
    expect(repository.createItem).toHaveBeenCalledWith(expect.objectContaining({ id: 'sku', totalQty: 8 }));
  });

  it('finds items and reports missing items', async () => {
    await expect(useCase.getItem('sku')).resolves.toBe(item);
    vi.mocked(repository.findItem).mockResolvedValueOnce(null);
    await expect(useCase.getItem('missing')).rejects.toBeInstanceOf(DomainNotFoundError);
  });

  it('delegates reserve and release', async () => {
    await expect(useCase.reserve('sku', 2)).resolves.toBe(reservation);
    expect(repository.reserve).toHaveBeenCalledWith('sku', 2, undefined);
    await expect(useCase.release('r1')).resolves.toBe(reservation);
    expect(repository.release).toHaveBeenCalledWith('r1');
  });
});
