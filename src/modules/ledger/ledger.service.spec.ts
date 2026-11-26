import { Money } from '../../shared/domain/money.js';
import { JOURNAL_SIDES, JournalEntry } from './domain/journal-entry.js';
import { LedgerService } from './ledger.service.js';

const entry = JournalEntry.create({
  id: 'entry-1',
  description: 'Sale',
  postedAt: new Date('2026-01-01T00:00:00.000Z'),
  lines: [
    { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: Money.fromMinorUnits(10n, 'USD') },
    { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: Money.fromMinorUnits(10n, 'USD') },
  ],
});

describe('LedgerService', () => {
  function setup(history: JournalEntry[] = []) {
    const post = { execute: vi.fn().mockResolvedValue(entry) };
    const reverse = { execute: vi.fn().mockResolvedValue(entry) };
    const entries = {
      getBalance: vi.fn().mockResolvedValue([]),
      getHistory: vi.fn().mockResolvedValue(history),
    };
    return { service: new LedgerService(post as never, reverse as never, entries as never), post, reverse, entries };
  }

  it('fingerprints post and reversal requests and delegates reads', async () => {
    const { service, post, reverse, entries } = setup();
    await service.post({
      id: 'entry-1', description: 'Sale', lines: entry.lines, postedAt: new Date('2026-01-01T00:00:00.000Z'), reversalOfEntryId: undefined,
    }, 'post-key');
    const postContext = post.execute.mock.calls[0]?.[1];
    expect(postContext).toMatchObject({ scope: 'ledger:post', key: 'post-key' });
    expect(postContext.fingerprint).toMatch(/^[a-f0-9]{64}$/);

    await service.reverse('entry-1', 'entry-2', 'reverse-key');
    expect(reverse.execute.mock.calls[0]?.[0]).toMatchObject({
      originalEntryId: 'entry-1',
      reversalEntryId: 'entry-2',
      idempotency: { scope: 'ledger:reverse', key: 'reverse-key' },
    });
    await service.getBalance('cash');
    expect(entries.getBalance).toHaveBeenCalledWith('cash');
  });

  it('validates page size and cursor, and returns a cursor only when another page exists', async () => {
    const { service, entries } = setup([entry, entry]);
    const page = await service.getHistory(undefined, '1');
    expect(page.items).toEqual([entry]);
    expect(page.nextCursor).toBeTruthy();
    expect(entries.getHistory).toHaveBeenCalledWith({ limit: 2, after: undefined });

    entries.getHistory.mockResolvedValueOnce([entry]);
    const finalPage = await service.getHistory(page.nextCursor!, '2');
    expect(finalPage.nextCursor).toBeNull();
    expect(entries.getHistory).toHaveBeenLastCalledWith({
      limit: 3,
      after: { id: 'entry-1', postedAt: entry.postedAt },
    });

    entries.getHistory.mockResolvedValueOnce([]);
    expect(await service.getHistory(undefined, undefined)).toMatchObject({ items: [], nextCursor: null });
    await expect(service.getHistory(undefined, '0')).rejects.toThrow('limit must be an integer');
    await expect(service.getHistory(undefined, '101')).rejects.toThrow('limit must be an integer');
    await expect(service.getHistory(undefined, '1.5')).rejects.toThrow('limit must be an integer');
    await expect(service.getHistory('not-a-cursor', '1')).rejects.toThrow('Invalid journal history cursor');
    await expect(service.getHistory(Buffer.from(JSON.stringify({ id: '', postedAt: '2026-01-01T00:00:00.000Z' })).toString('base64url'), '1'))
      .rejects.toThrow('Invalid journal history cursor');
    await expect(service.getHistory(Buffer.from(JSON.stringify({ id: 'entry-1', postedAt: 'invalid' })).toString('base64url'), '1'))
      .rejects.toThrow('Invalid journal history cursor');
  });
});
