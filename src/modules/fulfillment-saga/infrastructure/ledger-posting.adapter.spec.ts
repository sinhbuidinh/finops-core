import { LedgerPostingAdapter } from './ledger-posting.adapter.js';

describe('LedgerPostingAdapter', () => {
  it('forwards posting and reversal requests to the ledger service', async () => {
    const post = vi.fn().mockResolvedValue({ id: 'entry-1' });
    const reverse = vi.fn().mockResolvedValue({ id: 'entry-1:reversal' });
    const adapter = new LedgerPostingAdapter({ post, reverse } as never);
    const entry = { id: 'entry-1' } as never;
    const postingKey = { scope: 'fulfillment:saga:post', key: 'saga-1', fingerprint: 'entry-1' };
    const reversalKey = { scope: 'fulfillment:saga:reverse', key: 'saga-1', fingerprint: 'entry-1' };

    await expect(adapter.post(entry, postingKey)).resolves.toEqual({ id: 'entry-1' });
    expect(post).toHaveBeenCalledWith(entry, 'saga-1');
    await expect(adapter.reverse('entry-1', 'entry-1:reversal', reversalKey)).resolves.toEqual({ id: 'entry-1:reversal' });
    expect(reverse).toHaveBeenCalledWith('entry-1', 'entry-1:reversal', 'saga-1');
  });
});
