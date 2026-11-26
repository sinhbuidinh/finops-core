import type { Pool } from 'pg';
import { IdempotencyStore } from './idempotency-store.js';

describe('IdempotencyStore', () => {
  const input = {
    scope: 'tenant-1',
    key: 'payment-1',
    fingerprint: 'body-hash',
  };
  let query: ReturnType<typeof vi.fn>;
  let store: IdempotencyStore;

  beforeEach(() => {
    query = vi.fn();
    store = new IdempotencyStore({ query } as unknown as Pool);
  });

  it('atomically claims a new key and returns its owner token', async () => {
    query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ owner_token: 'owner-1' }],
    });

    await expect(store.acquire(input)).resolves.toEqual({
      kind: 'acquired',
      ownerToken: expect.any(String),
    });
    expect(query.mock.calls[0][0]).toContain(
      'ON CONFLICT (scope, key) DO UPDATE',
    );
    expect(query.mock.calls[0][1]).toEqual([
      input.scope,
      input.key,
      input.fingerprint,
      expect.any(String),
      60_000,
      86_400_000,
    ]);
  });

  it('returns the completed response for a matching retry', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            fingerprint: input.fingerprint,
            state: 'COMPLETED',
            lease_expires_at: null,
            response_status: 201,
            response_body: { paymentId: 'pay-1' },
          },
        ],
      });

    await expect(store.acquire(input)).resolves.toEqual({
      kind: 'completed',
      responseStatus: 201,
      responseBody: { paymentId: 'pay-1' },
    });
  });

  it('rejects a key reused with a different fingerprint', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [
          {
            fingerprint: 'different-body',
            state: 'COMPLETED',
            lease_expires_at: null,
            response_status: 201,
            response_body: {},
          },
        ],
      });

    await expect(store.acquire(input)).resolves.toEqual({ kind: 'key_reused' });
  });

  it('returns the active lease for a matching in-progress key', async () => {
    const leaseExpiresAt = new Date('2026-01-01T00:01:00.000Z');
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{
          fingerprint: input.fingerprint,
          state: 'IN_PROGRESS',
          lease_expires_at: leaseExpiresAt,
          response_status: null,
          response_body: null,
        }],
      });
    await expect(store.acquire(input)).resolves.toEqual({ kind: 'in_progress', leaseExpiresAt });
  });

  it('retries acquisition if the conflicting row disappears before it can be read', async () => {
    query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ owner_token: 'owner-2' }] });
    await expect(store.acquire(input)).resolves.toEqual({ kind: 'acquired', ownerToken: expect.any(String) });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('completes only the matching in-progress claim owner', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await store.complete(input, 'owner-1', 200, { ok: true });

    expect(query.mock.calls[0][0]).toContain(
      "state = 'IN_PROGRESS' AND owner_token = $7",
    );
    expect(query.mock.calls[0][1]).toEqual([
      input.scope,
      input.key,
      input.fingerprint,
      200,
      { ok: true },
      86_400_000,
      'owner-1',
    ]);
  });

  it('throws when completion no longer owns the claim', async () => {
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(store.complete(input, 'stale-owner', 201, {})).rejects.toThrow('Idempotency claim was lost');
  });

  it('releases only the matching claim and purges up to a bounded number of expired keys', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }).mockResolvedValueOnce({ rowCount: 7, rows: [] });
    await store.release(input, 'owner-1');
    await expect(store.purgeExpired(10)).resolves.toBe(7);
    expect(query.mock.calls[0][0]).toContain('DELETE FROM idempotency_keys');
    expect(query.mock.calls[1][1]).toEqual([10]);
  });

  it('returns zero when PostgreSQL reports no affected rows for the purge', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(store.purgeExpired()).resolves.toBe(0);
  });
});
