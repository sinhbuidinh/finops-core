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
      createWallet: vi.fn().mockResolvedValue({ walletId: 'wallet-1', tenantId: 'tenant-1', ledgerAccountId: 'wallet-account:wallet-1' }),
      findWallet: vi.fn().mockResolvedValue({ walletId: 'wallet-1', ledgerAccountId: 'wallet-account:wallet-1' }),
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
    await service.getBalance('cash', 'tenant-1');
    expect(entries.getBalance).toHaveBeenCalledWith('cash', 'tenant-1');
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

  it('creates wallets and posts wallet payments with an idempotency fingerprint', async () => {
    const { service, post, entries } = setup();
    await expect(service.createWallet('tenant-1', 'wallet-1', 'Main')).resolves.toEqual({ walletId: 'wallet-1', tenantId: 'tenant-1' });
    expect(entries.createWallet).toHaveBeenCalledWith({ tenantId: 'tenant-1', walletId: 'wallet-1', name: 'Main' });
    await expect(service.findWallet('wallet-1', 'tenant-1')).resolves.toEqual({ walletId: 'wallet-1', ledgerAccountId: 'wallet-account:wallet-1' });

    await service.postWalletPayment({
      tenantId: 'tenant-1', walletId: 'wallet-1', entryId: 'payment-1', description: 'Order payment',
      postedAt: '2026-01-02T00:00:00.000Z', amount: { minorUnits: '25', currency: 'USD' },
    }, 'payment-key');
    const [payment, context, tenantId] = post.execute.mock.calls[0]!;
    expect(payment.lines.map((line: { accountId: string; side: string; amount: Money }) => [line.accountId, line.side, line.amount.minorUnits])).toEqual([
      ['platform:order-clearing', 'DEBIT', 25n], ['wallet-account:wallet-1', 'CREDIT', 25n],
    ]);
    expect(context).toMatchObject({ scope: 'ledger:post', key: 'payment-key' });
    expect(context.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(tenantId).toBe('tenant-1');

    await service.postWalletPayment({
      tenantId: 'tenant-1', walletId: 'wallet-1', entryId: 'payment-2', description: 'Payment without explicit date',
      amount: { minorUnits: '5', currency: 'USD' },
    }, 'payment-key-2');
    expect(post.execute.mock.calls[1]?.[0].postedAt).toBeInstanceOf(Date);
  });

  it('rejects wallet payments for unknown wallets', async () => {
    const { service, entries, post } = setup();
    entries.findWallet.mockResolvedValueOnce(null);
    await expect(service.postWalletPayment({
      tenantId: 'tenant-1', walletId: 'missing', entryId: 'payment-1', description: 'Payment',
      amount: { minorUnits: '1', currency: 'USD' },
    }, 'payment-key')).rejects.toThrow('Wallet not found');
    expect(post.execute).not.toHaveBeenCalled();
  });
});
