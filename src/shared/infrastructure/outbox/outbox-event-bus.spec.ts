import { OutboxEventBus } from './outbox-event-bus.js';
import type { OutboxMessage } from './outbox-repository.js';

describe('OutboxEventBus', () => {
  const message: OutboxMessage = {
    eventId: '839e7ccd-cf42-4afe-857c-11ef6c5db32f',
    aggregateId: 'order-1',
    eventName: 'order.placed',
    payload: { total: 1200 },
    occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    attempts: 1,
    claimToken: 'claim-1',
  };

  it('awaits all handlers subscribed to an event before delivery completes', async () => {
    const bus = new OutboxEventBus();
    const first = vi.fn().mockResolvedValue(undefined);
    const second = vi.fn().mockResolvedValue(undefined);
    bus.subscribe('order.placed', first);
    bus.subscribe('order.placed', second);

    await bus.publish(message);

    expect(first).toHaveBeenCalledWith(message);
    expect(second).toHaveBeenCalledWith(message);
  });

  it('fails delivery when no handler is registered so the relay can retry it', async () => {
    const bus = new OutboxEventBus();

    await expect(bus.publish(message)).rejects.toThrow(
      'No outbox handler registered for order.placed',
    );
  });
});
