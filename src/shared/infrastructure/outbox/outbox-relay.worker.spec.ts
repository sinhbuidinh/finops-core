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
});
