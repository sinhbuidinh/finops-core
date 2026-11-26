import type { Pool, PoolClient } from 'pg';
import { OutboxRepository } from './outbox-repository.js';

describe('OutboxRepository', () => {
  let query: ReturnType<typeof vi.fn>;
  let repository: OutboxRepository;

  beforeEach(() => {
    query = vi.fn();
    repository = new OutboxRepository({ query } as unknown as Pool);
  });

  it('inserts the event using the caller transaction client', async () => {
    const transactionQuery = vi
      .fn()
      .mockResolvedValue({ rowCount: 1, rows: [] });
    const event = {
      eventId: '839e7ccd-cf42-4afe-857c-11ef6c5db32f',
      aggregateId: 'order-1',
      eventName: 'order.placed',
      payload: { total: 1200 },
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
    };

    await repository.enqueue(
      { query: transactionQuery } as unknown as PoolClient,
      event,
    );

    expect(transactionQuery).toHaveBeenCalledOnce();
    expect(transactionQuery.mock.calls[0][0]).toContain(
      'INSERT INTO outbox_events',
    );
    expect(transactionQuery.mock.calls[0][1]).toEqual([
      event.eventId,
      event.aggregateId,
      event.eventName,
      event.payload,
      event.occurredAt,
    ]);
    expect(query).not.toHaveBeenCalled();
  });

  it('claims due events with a lease and returns their claim token', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            event_id: '839e7ccd-cf42-4afe-857c-11ef6c5db32f',
            aggregate_id: 'order-1',
            event_name: 'order.placed',
            payload: { total: 1200 },
            occurred_at: new Date('2026-01-01T00:00:00.000Z'),
            attempts: 1,
            locked_by: 'claim-1',
          },
        ],
      });

    await expect(
      repository.claimBatch(20, 30_000, {
        maxAttempts: 8,
        baseDelayMs: 1000,
        maxDelayMs: 300_000,
      }),
    ).resolves.toEqual([
      {
        eventId: '839e7ccd-cf42-4afe-857c-11ef6c5db32f',
        aggregateId: 'order-1',
        eventName: 'order.placed',
        payload: { total: 1200 },
        occurredAt: new Date('2026-01-01T00:00:00.000Z'),
        attempts: 1,
        claimToken: 'claim-1',
      },
    ]);
    expect(query.mock.calls[1][0]).toContain('FOR UPDATE SKIP LOCKED');
    expect(query.mock.calls[1][1]).toEqual([20, 30_000, 8]);
  });

  it('backs off exponentially and dead-letters at the attempt limit', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const event = {
      eventId: '839e7ccd-cf42-4afe-857c-11ef6c5db32f',
      aggregateId: 'order-1',
      eventName: 'order.placed',
      payload: {},
      occurredAt: new Date(),
      attempts: 3,
      claimToken: 'claim-1',
    };

    await repository.markFailed(
      event,
      event.claimToken,
      new Error('handler failed'),
      {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 3000,
      },
    );

    expect(query.mock.calls[0][0]).toContain(
      "THEN 'DEAD_LETTER' ELSE 'PENDING'",
    );
    expect(query.mock.calls[0][1]).toEqual([
      event.eventId,
      event.claimToken,
      3,
      3000,
      'handler failed',
    ]);
  });
});
