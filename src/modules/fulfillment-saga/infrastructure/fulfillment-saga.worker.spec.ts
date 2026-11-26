import { FulfillmentSagaWorker } from './fulfillment-saga.worker.js';

describe('FulfillmentSagaWorker', () => {
  it('clears its busy lock when acquiring a database connection fails', async () => {
    const clientQuery = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const client = { query: clientQuery, release };
    const connect = vi.fn().mockRejectedValueOnce(new Error('database unavailable')).mockResolvedValue(client);
    const worker = new FulfillmentSagaWorker({ connect, query: vi.fn() } as never, {} as never);

    await worker.runOnce();
    await worker.runOnce();

    expect(connect).toHaveBeenCalledTimes(2);
    expect(clientQuery).toHaveBeenCalledWith('BEGIN');
    expect(release).toHaveBeenCalledOnce();
  });
});
