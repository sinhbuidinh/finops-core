import { DomainConflictError, DomainNotFoundError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { InventoryItem } from '../domain/inventory-item.js';
import { PostgresInventoryRepository } from './postgres-inventory.repository.js';

describe('PostgresInventoryRepository', () => {
  const poolQuery = vi.fn();
  const clientQuery = vi.fn();
  const releaseClient = vi.fn();
  const client = { query: clientQuery, release: releaseClient };
  const pool = { query: poolQuery, connect: vi.fn().mockResolvedValue(client) };
  const repository = new PostgresInventoryRepository(pool as never);

  beforeEach(() => {
    vi.clearAllMocks();
    pool.connect.mockResolvedValue(client);
  });

  it('creates and maps an inventory item; maps duplicate IDs to a conflict', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', item_id: 'sku', total_qty: 5, reserved_qty: 1, version: 2 }] });
    await expect(repository.createItem(InventoryItem.create({ tenantId: 'tenant-1', id: 'sku', totalQty: 5 })))
      .resolves.toMatchObject({ id: 'sku', availableQty: 4, version: 2 });
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
    poolQuery.mockRejectedValueOnce(duplicate);
    await expect(repository.createItem(InventoryItem.create({ tenantId: 'tenant-1', id: 'sku', totalQty: 5 })))
      .rejects.toMatchObject({ code: 'INVENTORY_ITEM_EXISTS' });
    poolQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(repository.createItem(InventoryItem.create({ tenantId: 'tenant-1', id: 'sku', totalQty: 5 }))).rejects.toThrow('database unavailable');
  });

  it('finds an item or returns null', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ tenant_id: 'tenant-1', item_id: 'sku', total_qty: 5, reserved_qty: 2, version: 1 }] });
    await expect(repository.findItem('tenant-1', 'sku')).resolves.toMatchObject({ tenantId: 'tenant-1', availableQty: 3 });
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(repository.findItem('tenant-2', 'sku')).resolves.toBeNull();
    expect(poolQuery).toHaveBeenLastCalledWith(expect.stringContaining('WHERE tenant_id = $1 AND item_id = $2'), ['tenant-2', 'sku']);
  });

  it('reserves stock atomically and commits the matching reservation', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE inventory_items')) return { rowCount: 1, rows: [{ item_id: 'sku' }] };
      return { rowCount: 1, rows: [] };
    });
    const reservation = await repository.reserve('tenant-1', 'sku', 2);
    expect(reservation).toMatchObject({ tenantId: 'tenant-1', itemId: 'sku', quantity: 2, status: 'ACTIVE' });
    expect(reservation.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(clientQuery.mock.calls.map(([sql]) => sql.trim())).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it('replays an active saga reservation without incrementing reserved stock again', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM stock_reservations')) return { rows: [{ reservation_id: 'r1', tenant_id: 'tenant-1', item_id: 'sku', quantity: 2, status: 'ACTIVE' }] };
      return { rowCount: 1, rows: [] };
    });
    await expect(repository.reserve('tenant-1', 'sku', 2, 'saga-1')).resolves.toMatchObject({ id: 'r1', tenantId: 'tenant-1', status: 'ACTIVE' });
    expect(clientQuery).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE inventory_items'), expect.anything());
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects reuse of a reservation key with different inventory details', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM stock_reservations')) {
        return { rows: [{ reservation_id: 'r1', tenant_id: 'tenant-1', item_id: 'other-sku', quantity: 2, status: 'ACTIVE' }] };
      }
      return { rowCount: 1, rows: [] };
    });

    const outcome = repository.reserve('tenant-1', 'sku', 2, 'saga-1');
    await expect(outcome).rejects.toBeInstanceOf(DomainConflictError);
    await expect(outcome).rejects.toMatchObject({ code: 'RESERVATION_IDEMPOTENCY_KEY_REUSED' });
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it('reactivates a compensated saga reservation so a retry can reserve stock again', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM stock_reservations')) return { rows: [{ reservation_id: 'r1', tenant_id: 'tenant-1', item_id: 'sku', quantity: 2, status: 'RELEASED' }] };
      if (sql.includes('UPDATE inventory_items')) return { rowCount: 1, rows: [{ item_id: 'sku' }] };
      return { rowCount: 1, rows: [] };
    });
    await expect(repository.reserve('tenant-1', 'sku', 2, 'saga-1')).resolves.toMatchObject({ id: 'r1', tenantId: 'tenant-1', status: 'ACTIVE' });
    expect(clientQuery).toHaveBeenCalledWith(expect.stringContaining("SET status = 'ACTIVE'"), ['r1', 'tenant-1']);
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects reactivation when the released quantity no longer fits available stock', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM stock_reservations')) {
        return { rows: [{ reservation_id: 'r1', tenant_id: 'tenant-1', item_id: 'sku', quantity: 2, status: 'RELEASED' }] };
      }
      if (sql.includes('UPDATE inventory_items')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });

    await expect(repository.reserve('tenant-1', 'sku', 2, 'saga-1'))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it('rejects invalid reservations before connecting', async () => {
    await expect(repository.reserve('tenant-1', 'sku', 0)).rejects.toBeInstanceOf(DomainValidationError);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('distinguishes a missing item from insufficient stock and rolls back', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE inventory_items')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT 1')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    await expect(repository.reserve('tenant-1', 'missing', 1)).rejects.toBeInstanceOf(DomainNotFoundError);
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');

    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE inventory_items')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT 1')) return { rowCount: 1, rows: [{}] };
      return { rowCount: 0, rows: [] };
    });
    await expect(repository.reserve('tenant-1', 'sku', 1)).rejects.toMatchObject({ code: 'INSUFFICIENT_INVENTORY' });
    expect(releaseClient).toHaveBeenCalledTimes(2);
  });

  it('rolls back a reservation when persistence fails', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE inventory_items')) return { rowCount: 1, rows: [] };
      if (sql.includes('INSERT INTO stock_reservations')) throw new Error('insert failed');
      return { rowCount: 1, rows: [] };
    });
    await expect(repository.reserve('tenant-1', 'sku', 1)).rejects.toThrow('insert failed');
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it('preserves reservation errors if rollback itself also fails', async () => {
    clientQuery.mockRejectedValueOnce(new Error('begin failed')).mockRejectedValueOnce(new Error('rollback failed'));
    await expect(repository.reserve('tenant-1', 'sku', 1)).rejects.toThrow('begin failed');
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it('releases active reservations and returns stock', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE stock_reservations')) {
        return { rowCount: 1, rows: [{ reservation_id: 'r1', tenant_id: 'tenant-1', item_id: 'sku', quantity: 2, status: 'RELEASED' }] };
      }
      if (sql.includes('UPDATE inventory_items')) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    await expect(repository.release('tenant-1', 'r1')).resolves.toMatchObject({ id: 'r1', tenantId: 'tenant-1', itemId: 'sku', quantity: 2, status: 'RELEASED' });
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it('distinguishes unknown reservations and makes release safely repeatable', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE stock_reservations')) return { rowCount: 0, rows: [] };
      return { rowCount: 0, rows: [] };
    });
    await expect(repository.release('tenant-1', 'missing')).rejects.toBeInstanceOf(DomainNotFoundError);
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE stock_reservations')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ reservation_id: 'r1', tenant_id: 'tenant-1', item_id: 'sku', quantity: 2, status: 'RELEASED' }] };
    });
    await expect(repository.release('tenant-1', 'r1')).resolves.toMatchObject({ id: 'r1', tenantId: 'tenant-1', status: 'RELEASED' });
    expect(releaseClient).toHaveBeenCalledTimes(2);
  });

  it('rolls back release if the inventory invariant cannot be maintained', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('UPDATE stock_reservations')) {
        return { rowCount: 1, rows: [{ reservation_id: 'r1', tenant_id: 'tenant-1', item_id: 'sku', quantity: 2, status: 'RELEASED' }] };
      }
      if (sql.includes('UPDATE inventory_items')) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [] };
    });
    await expect(repository.release('tenant-1', 'r1')).rejects.toBeInstanceOf(DomainValidationError);
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rolls back and rethrows unexpected release failures', async () => {
    clientQuery.mockRejectedValueOnce(new Error('transaction failed'));
    await expect(repository.release('tenant-1', 'r1')).rejects.toThrow('transaction failed');
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(releaseClient).toHaveBeenCalledOnce();
  });

  it('preserves release errors if rollback itself also fails', async () => {
    clientQuery.mockRejectedValueOnce(new Error('begin failed')).mockRejectedValueOnce(new Error('rollback failed'));
    await expect(repository.release('tenant-1', 'r1')).rejects.toThrow('begin failed');
    expect(releaseClient).toHaveBeenCalledOnce();
  });
});
