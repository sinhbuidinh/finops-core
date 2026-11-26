import { OutboxRelayWorker } from './outbox-relay.worker.js';
import type { OutboxEventBus } from './outbox-event-bus.js';
import type { OutboxMessage, OutboxRepository } from './outbox-repository.js';

describe('OutboxRelayWorker', () => {
  const event: OutboxMessage = {
    eventId: '839e7ccd-cf42-4afe-857c-11ef6c5db32f',
    aggregateId: 'order-1',
    eventName: 'order.placed',
    payload: { total: 1200 },
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    attempts: 1,
    claimToken: 'claim-1',
  };
  let repository: {
    claimBatch: ReturnType<typeof vi.fn>;
    markPublished: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
  let eventBus: { publish: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    repository = {
      claimBatch: vi.fn().mockResolvedValue([event]),
      markPublished: vi.fn().mockResolvedValue(undefined),
      markFailed: vi.fn().mockResolvedValue(undefined),
    };
    eventBus = { publish: vi.fn().mockResolvedValue(undefined) };
  });

  it('publishes claimed events and marks them published', async () => {
    const worker = new OutboxRelayWorker(
      repository as unknown as OutboxRepository,
      eventBus as unknown as OutboxEventBus,
    );

    await worker.runOnce();

    expect(eventBus.publish).toHaveBeenCalledWith(event);
    expect(repository.markPublished).toHaveBeenCalledWith(
      event.eventId,
      event.claimToken,
    );
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it('records delivery failures for retry instead of marking them published', async () => {
    const deliveryError = new Error('temporary subscriber outage');
    eventBus.publish.mockRejectedValueOnce(deliveryError);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worker = new OutboxRelayWorker(
      repository as unknown as OutboxRepository,
      eventBus as unknown as OutboxEventBus,
    );

    await worker.runOnce();

    expect(repository.markFailed).toHaveBeenCalledWith(
      event,
      event.claimToken,
      deliveryError,
      expect.objectContaining({ maxAttempts: 8, baseDelayMs: 1000 }),
    );
    expect(repository.markPublished).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs poll failures and keeps the worker usable', async () => {
    const failure = new Error('database unavailable');
    repository.claimBatch.mockRejectedValueOnce(failure);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const worker = new OutboxRelayWorker(repository as unknown as OutboxRepository, eventBus as unknown as OutboxEventBus);

    await worker.runOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(repository.claimBatch).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it('does not overlap polling and can run again after the active poll completes', async () => {
    let finish!: (batch: OutboxMessage[]) => void;
    repository.claimBatch.mockImplementationOnce(() => new Promise<OutboxMessage[]>((resolve) => { finish = resolve; }));
    const worker = new OutboxRelayWorker(repository as unknown as OutboxRepository, eventBus as unknown as OutboxEventBus);

    const active = worker.runOnce();
    await worker.runOnce();
    expect(repository.claimBatch).toHaveBeenCalledOnce();
    finish([]);
    await active;
    await worker.runOnce();
    expect(repository.claimBatch).toHaveBeenCalledTimes(2);
  });

  it('logs when failure recording fails, including an error thrown by publication marking', async () => {
    eventBus.publish.mockRejectedValueOnce(new Error('subscriber failed'));
    repository.markFailed.mockRejectedValueOnce(new Error('database unavailable'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const worker = new OutboxRelayWorker(repository as unknown as OutboxRepository, eventBus as unknown as OutboxEventBus);

    await worker.runOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    error.mockRestore();
    warn.mockRestore();
  });

  it('starts an immediate poll and clears its timer on shutdown', () => {
    const interval = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(interval);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const worker = new OutboxRelayWorker(repository as unknown as OutboxRepository, eventBus as unknown as OutboxEventBus);
    const run = vi.spyOn(worker, 'runOnce').mockResolvedValue();

    worker.onModuleInit();
    expect(setIntervalSpy).toHaveBeenCalledOnce();
    expect(interval.unref).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    setIntervalSpy.mock.calls[0]![0]();
    expect(run).toHaveBeenCalledTimes(2);
    worker.onModuleDestroy();
    expect(clearIntervalSpy).toHaveBeenCalledWith(interval);
    new OutboxRelayWorker(repository as unknown as OutboxRepository, eventBus as unknown as OutboxEventBus).onModuleDestroy();

    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
