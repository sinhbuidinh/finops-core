import { LedgerPostingAdapter } from './ledger-posting.adapter.js';

describe('LedgerPostingAdapter', () => {
  it('forwards posting and reversal requests to the ledger service', async () => {
    const postWalletPayment = vi.fn().mockResolvedValue({ id: 'entry-1' });
    const reverse = vi.fn().mockResolvedValue({ id: 'entry-1:reversal' });
    const adapter = new LedgerPostingAdapter({ postWalletPayment, reverse } as never);
    const postingKey = { scope: 'fulfillment:saga:post', key: 'saga-1', fingerprint: 'entry-1' };
    const reversalKey = { scope: 'fulfillment:saga:reverse', key: 'saga-1', fingerprint: 'entry-1' };
    const payment = { tenantId: 'tenant-1', walletId: 'wallet-1', entryId: 'entry-1', description: 'Order payment', amount: { minorUnits: '100', currency: 'USD' } };

    await expect(adapter.postWalletPayment(payment, postingKey)).resolves.toEqual({ id: 'entry-1' });
    expect(postWalletPayment).toHaveBeenCalledWith(payment, 'saga-1');
    await expect(adapter.reverse('entry-1', 'entry-1:reversal', 'tenant-1', reversalKey)).resolves.toEqual({ id: 'entry-1:reversal' });
    expect(reverse).toHaveBeenCalledWith('entry-1', 'entry-1:reversal', 'saga-1', 'tenant-1');
  });
});
