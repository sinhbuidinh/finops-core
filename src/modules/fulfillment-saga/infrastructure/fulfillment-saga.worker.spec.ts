import { FulfillmentSagaWorker } from './fulfillment-saga.worker.js';

describe('FulfillmentSagaWorker', () => {
  const row = {
    saga_id: 'saga-1', order_id: 'order-1', attempts: 0,
    payload: { sagaId: 'saga-1', orderId: 'order-1', tenantId: 'tenant-1' },
  };

  const makeClient = (queries: ReturnType<typeof vi.fn>) => ({ query: queries, release: vi.fn() });

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

  it('ignores overlapping polls and allows shutdown before initialization', async () => {
    let resolveConnect!: (client: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }) => void;
    const connect = vi.fn(() => new Promise((resolve) => { resolveConnect = resolve; }));
    const worker = new FulfillmentSagaWorker({ connect } as never, {} as never);
    const firstPoll = worker.runOnce();
    await worker.runOnce();
    expect(connect).toHaveBeenCalledOnce();
    worker.onModuleDestroy();

    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    resolveConnect({ query, release });
    await firstPoll;
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('commits an empty poll without starting the saga', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const release = vi.fn();
    const saga = { execute: vi.fn() };
    const worker = new FulfillmentSagaWorker({ connect: vi.fn().mockResolvedValue({ query, release }) } as never, saga as never);

    await worker.runOnce();

    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(saga.execute).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('runs a claimed saga, advances payment state, and completes the order', async () => {
    const startQuery = vi.fn(async (sql: string) => sql.startsWith('SELECT') ? { rows: [row] } : { rows: [], rowCount: 1 });
    const finishQuery = vi.fn(async (sql: string) => sql.includes('UPDATE fulfillment_orders') ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 1 });
    const startClient = makeClient(startQuery);
    const finishClient = makeClient(finishQuery);
    const connect = vi.fn().mockResolvedValueOnce(startClient).mockResolvedValueOnce(finishClient);
    const poolQuery = vi.fn().mockResolvedValue({ rowCount: 1 });
    const execute = vi.fn(async (context: { onPaymentStarting?: () => Promise<void> }) => context.onPaymentStarting?.());
    const worker = new FulfillmentSagaWorker({ connect, query: poolQuery } as never, { execute } as never);

    await worker.runOnce();

    expect(execute).toHaveBeenCalledOnce();
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE fulfillment_orders'), expect.any(Array));
    expect(finishQuery).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO outbox_events'), expect.any(Array));
    expect(finishQuery).toHaveBeenCalledWith('COMMIT');
    expect(startClient.release).toHaveBeenCalledOnce();
    expect(finishClient.release).toHaveBeenCalledOnce();
  });

  it('schedules a failed saga for retry and truncates the stored error', async () => {
    const startQuery = vi.fn(async (sql: string) => sql.startsWith('SELECT') ? { rows: [{ ...row, attempts: 2 }] } : { rows: [], rowCount: 1 });
    const client = makeClient(startQuery);
    const poolQuery = vi.fn().mockResolvedValue({ rowCount: 1 });
    const worker = new FulfillmentSagaWorker(
      { connect: vi.fn().mockResolvedValue(client), query: poolQuery } as never,
      { execute: vi.fn().mockRejectedValue(new Error('x'.repeat(4500))) } as never,
    );

    await worker.runOnce();

    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("SET state = 'PENDING'"), ['saga-1', 4000, 'x'.repeat(4000)]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('marks an exhausted saga failed and keeps compensation failures retryable', async () => {
    const startQuery = vi.fn(async (sql: string) => sql.startsWith('SELECT') ? { rows: [{ ...row, attempts: 4 }] } : { rows: [], rowCount: 1 });
    const failedOrderQuery = vi.fn(async (sql: string) => sql.includes('UPDATE fulfillment_orders') ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 1 });
    const connect = vi.fn().mockResolvedValueOnce(makeClient(startQuery)).mockResolvedValueOnce(makeClient(failedOrderQuery));
    const worker = new FulfillmentSagaWorker(
      { connect, query: vi.fn() } as never,
      { execute: vi.fn().mockRejectedValue(new Error('payment failed')) } as never,
    );

    await worker.runOnce();

    expect(failedOrderQuery.mock.calls.some(([sql, params]) =>
      String(sql).includes('INSERT INTO outbox_events') && (params as unknown[])[2] === 'FulfillmentSagaFAILED',
    )).toBe(true);

    const retryPoolQuery = vi.fn().mockResolvedValue({ rowCount: 1 });
    const retryClient = makeClient(startQuery);
    const retryWorker = new FulfillmentSagaWorker(
      { connect: vi.fn().mockResolvedValue(retryClient), query: retryPoolQuery } as never,
      { execute: vi.fn().mockRejectedValue(new AggregateError([new Error('compensation failed')])) } as never,
    );
    await retryWorker.runOnce();
    expect(retryPoolQuery).toHaveBeenCalledWith(expect.stringContaining("SET state = 'PENDING'"), expect.any(Array));
  });

  it('stringifies a non-Error failure when exhausting retries', async () => {
    const startQuery = vi.fn(async (sql: string) => sql.startsWith('SELECT') ? { rows: [{ ...row, attempts: 4 }] } : { rows: [], rowCount: 1 });
    const failedQuery = vi.fn(async (sql: string) => sql.includes('UPDATE fulfillment_orders') ? { rows: [], rowCount: 1 } : { rows: [], rowCount: 1 });
    const worker = new FulfillmentSagaWorker(
      { connect: vi.fn().mockResolvedValueOnce(makeClient(startQuery)).mockResolvedValueOnce(makeClient(failedQuery)), query: vi.fn() } as never,
      { execute: vi.fn().mockRejectedValue('unexpected failure') } as never,
    );

    await worker.runOnce();

    const insert = failedQuery.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO outbox_events'));
    expect(insert?.[1]?.[3]).toMatchObject({ error: 'unexpected failure' });
  });

  it('rejects payment settlement if the order changed and releases the polling timer on shutdown', async () => {
    const startQuery = vi.fn(async (sql: string) => sql.startsWith('SELECT') ? { rows: [row] } : { rows: [], rowCount: 1 });
    const poolQuery = vi.fn().mockResolvedValue({ rowCount: 0 });
    const worker = new FulfillmentSagaWorker(
      { connect: vi.fn().mockResolvedValue(makeClient(startQuery)), query: poolQuery } as never,
      { execute: vi.fn(async (context: { onPaymentStarting?: () => Promise<void> }) => context.onPaymentStarting?.()) } as never,
    );
    await worker.runOnce();
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining('UPDATE fulfillment_orders'), expect.any(Array));

    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setInterval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearInterval = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const idleWorker = new FulfillmentSagaWorker({} as never, {} as never);
    vi.spyOn(idleWorker, 'runOnce').mockResolvedValue(undefined);
    idleWorker.onModuleInit();
    idleWorker.onModuleDestroy();
    expect(setInterval).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    expect(clearInterval).toHaveBeenCalledWith(timer);
    setInterval.mockRestore();
    clearInterval.mockRestore();
  });

  it('rolls back a failed completion transaction and schedules the saga for retry', async () => {
    const startQuery = vi.fn(async (sql: string) => sql.startsWith('SELECT') ? { rows: [row] } : { rows: [], rowCount: 1 });
    const finishQuery = vi.fn(async (sql: string) => sql.includes('UPDATE fulfillment_orders') ? { rows: [], rowCount: 0 } : { rows: [], rowCount: 1 });
    const startClient = makeClient(startQuery);
    const finishClient = makeClient(finishQuery);
    const poolQuery = vi.fn().mockResolvedValue({ rowCount: 1 });
    const worker = new FulfillmentSagaWorker(
      { connect: vi.fn().mockResolvedValueOnce(startClient).mockResolvedValueOnce(finishClient), query: poolQuery } as never,
      { execute: vi.fn() } as never,
    );

    await worker.runOnce();

    expect(finishQuery).toHaveBeenCalledWith('ROLLBACK');
    expect(poolQuery).toHaveBeenCalledWith(expect.stringContaining("SET state = 'PENDING'"), expect.any(Array));
    expect(finishClient.release).toHaveBeenCalledOnce();
  });
});
