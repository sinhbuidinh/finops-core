import { ReserveInventoryStep, SettleLedgerPaymentStep, type FulfillmentContext } from './saga-steps.js';

const context: FulfillmentContext = {
  sagaId: 'saga-1', orderId: 'order-1', tenantId: 'tenant-1', inventoryItemId: 'sku-1', quantity: 2,
  payment: { id: 'entry-1', description: 'Order payment', lines: [
    { accountId: 'cash', side: 'DEBIT', amount: { minorUnits: '100', currency: 'USD' } },
    { accountId: 'revenue', side: 'CREDIT', amount: { minorUnits: '100', currency: 'USD' } },
  ] },
};

describe('fulfillment saga steps', () => {
  it('uses a stable saga reservation key so a step can recover after a lost response', async () => {
    const reserve = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ id: 'reservation-1' });
    const step = new ReserveInventoryStep({ reserve } as never);
    await expect(step.execute(context)).rejects.toThrow('response lost');
    await expect(step.execute(context)).resolves.toBe('reservation-1');
    expect(reserve).toHaveBeenNthCalledWith(1, 'tenant-1', 'sku-1', 2, 'fulfillment:saga-1');
    expect(reserve).toHaveBeenNthCalledWith(2, 'tenant-1', 'sku-1', 2, 'fulfillment:saga-1');
  });

  it('uses a stable ledger idempotency key after a post commits but its response is lost', async () => {
    const post = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ id: 'entry-1' });
    const step = new SettleLedgerPaymentStep({ post } as never);
    await expect(step.execute(context)).rejects.toThrow('response lost');
    await expect(step.execute(context)).resolves.toBe('entry-1');
    expect(post.mock.calls[0]![1]).toEqual(post.mock.calls[1]![1]);
    expect(post.mock.calls[0]![1]).toMatchObject({ scope: 'fulfillment:saga:post', key: 'saga-1' });
  });
});
