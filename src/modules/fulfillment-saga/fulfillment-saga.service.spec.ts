import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { FulfillmentSagaService } from './fulfillment-saga.service.js';
import { OrderState } from './domain/order-state-machine.js';

const payload = {
  tenantId: 'tenant-1', inventoryItemId: 'sku-1', quantity: 2,
  payment: { id: 'entry-1', description: 'Order payment', lines: [] },
};

function setup() {
  const clientQuery = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
  const release = vi.fn();
  const client = { query: clientQuery, release };
  const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
  const idempotency = {
    acquire: vi.fn().mockResolvedValue({ kind: 'acquired', ownerToken: 'owner-1' }),
    complete: vi.fn().mockResolvedValue(undefined),
    release: vi.fn().mockResolvedValue(undefined),
  };
  return { service: new FulfillmentSagaService(pool as never, idempotency as never), pool, client, clientQuery, release, idempotency };
}

describe('FulfillmentSagaService', () => {
  it('validates order keys and payload fields before acquiring idempotency', async () => {
    const { service, idempotency } = setup();
    await expect(service.createOrder(payload, ' ')).rejects.toThrow(BadRequestException);
    for (const invalid of [
      { ...payload, tenantId: '' }, { ...payload, inventoryItemId: '' }, { ...payload, quantity: 0 },
      { ...payload, quantity: 1.5 }, { ...payload, payment: { ...payload.payment, id: '' } },
      { ...payload, payment: { ...payload.payment, lines: null } },
      { ...payload, payment: { ...payload.payment, postedAt: 'invalid-date' } },
    ]) await expect(service.createOrder(invalid, 'key')).rejects.toThrow(BadRequestException);
    expect(idempotency.acquire).not.toHaveBeenCalled();
  });

  it('persists an order and saga job, then caches the accepted response', async () => {
    const { service, clientQuery, release, idempotency } = setup();
    const result = await service.createOrder(payload, 'key');
    expect(result).toMatchObject({ tenantId: 'tenant-1', state: OrderState.APPROVED });
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(clientQuery).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledOnce();
    expect(idempotency.complete).toHaveBeenCalledWith(expect.objectContaining({ scope: 'orders:create', key: 'key' }), 'owner-1', 202, result);
  });

  it.each([
    [{ kind: 'completed', responseBody: { id: 'existing' } }, 'completed'],
    [{ kind: 'in_progress' }, 'in_progress'],
    [{ kind: 'key_reused' }, 'key_reused'],
  ])('handles create-order idempotency claim %s', async (claim, kind) => {
    const { service, idempotency, pool } = setup();
    idempotency.acquire.mockResolvedValueOnce(claim as never);
    if (kind === 'completed') await expect(service.createOrder(payload, 'key')).resolves.toEqual({ id: 'existing' });
    else await expect(service.createOrder(payload, 'key')).rejects.toThrow(ConflictException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('rolls back and releases its idempotency claim when order persistence fails', async () => {
    const { service, clientQuery, release, idempotency } = setup();
    clientQuery.mockRejectedValueOnce(new Error('insert failed'));
    await expect(service.createOrder(payload, 'key')).rejects.toThrow('insert failed');
    expect(clientQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
    expect(idempotency.release).toHaveBeenCalledOnce();
  });

  it('preserves the original create error when rollback and idempotency release also fail', async () => {
    const { service, clientQuery, idempotency } = setup();
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') throw new Error('begin failed');
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [] };
    });
    idempotency.release.mockRejectedValueOnce(new Error('release failed'));
    await expect(service.createOrder(payload, 'key')).rejects.toThrow('begin failed');
  });

  it('reads orders within their tenant and reports missing orders', async () => {
    const { service, pool } = setup();
    pool.query.mockResolvedValueOnce({ rows: [{ id: 'order-1', tenant_id: 'tenant-1', state: OrderState.APPROVED, saga_id: 'saga-1', created_at: new Date(0) }] });
    await expect(service.getOrder('tenant-1', 'order-1')).resolves.toMatchObject({ id: 'order-1', tenantId: 'tenant-1', sagaId: 'saga-1' });
    pool.query.mockResolvedValueOnce({ rows: [] });
    await expect(service.getOrder('tenant-2', 'order-1')).rejects.toThrow(NotFoundException);
  });

  it('cancels an approved order and marks its pending job failed', async () => {
    const { service, clientQuery, release, idempotency } = setup();
    clientQuery.mockImplementation(async (sql: string) => sql.includes('SELECT id, state, saga_id')
      ? { rows: [{ id: 'order-1', state: OrderState.APPROVED, saga_id: 'saga-1' }] }
      : { rows: [], rowCount: 1 });
    await expect(service.cancelOrder('tenant-1', 'order-1', 'cancel-key')).resolves.toEqual({ id: 'order-1', state: OrderState.CANCELLED });
    expect(clientQuery).toHaveBeenCalledWith('COMMIT');
    expect(release).toHaveBeenCalledOnce();
    expect(idempotency.complete).toHaveBeenCalledWith(expect.objectContaining({ key: 'cancel-key' }), 'owner-1', 200, { id: 'order-1', state: OrderState.CANCELLED });
  });

  it('rejects invalid, missing, and non-approved cancellations and releases the claim', async () => {
    const { service, clientQuery, idempotency } = setup();
    await expect(service.cancelOrder('tenant-1', 'order-1', '')).rejects.toThrow(BadRequestException);
    clientQuery.mockImplementation(async () => ({ rows: [] }));
    await expect(service.cancelOrder('tenant-1', 'missing', 'key')).rejects.toThrow(NotFoundException);
    clientQuery.mockImplementation(async () => ({ rows: [{ id: 'order-1', state: OrderState.CONFIRMED, saga_id: 'saga-1' }] }));
    await expect(service.cancelOrder('tenant-1', 'order-1', 'key')).rejects.toThrow(ConflictException);
    expect(idempotency.release).toHaveBeenCalledTimes(2);
  });

  it('preserves the original cancellation error when rollback and claim release also fail', async () => {
    const { service, clientQuery, idempotency } = setup();
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN') throw new Error('begin failed');
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [] };
    });
    idempotency.release.mockRejectedValueOnce(new Error('release failed'));
    await expect(service.cancelOrder('tenant-1', 'order-1', 'key')).rejects.toThrow('begin failed');
  });

  it.each([
    [{ kind: 'completed', responseBody: { state: OrderState.CANCELLED } }, 'completed'],
    [{ kind: 'in_progress' }, 'in_progress'],
    [{ kind: 'key_reused' }, 'key_reused'],
  ])('handles cancellation idempotency claim %s', async (claim, kind) => {
    const { service, idempotency, pool } = setup();
    idempotency.acquire.mockResolvedValueOnce(claim as never);
    if (kind === 'completed') await expect(service.cancelOrder('tenant-1', 'order-1', 'key')).resolves.toMatchObject({ state: OrderState.CANCELLED });
    else await expect(service.cancelOrder('tenant-1', 'order-1', 'key')).rejects.toThrow(ConflictException);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('starts a saga with a supplied or generated saga ID', async () => {
    const { service, pool } = setup();
    await expect(service.start({ ...payload, orderId: 'order-1', sagaId: 'saga-given' })).resolves.toEqual({ sagaId: 'saga-given' });
    const generated = await service.start({ ...payload, orderId: 'order-2' });
    expect(generated.sagaId).toBeTruthy();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });
});
