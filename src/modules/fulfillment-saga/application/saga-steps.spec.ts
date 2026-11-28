import {
  ReleaseInventoryStep,
  ReserveInventoryStep,
  ReverseLedgerEntryStep,
  SettleLedgerPaymentStep,
  type FulfillmentContext,
} from './saga-steps.js';

const context: FulfillmentContext = {
  sagaId: 'saga-1', orderId: 'order-1', tenantId: 'tenant-1', inventoryItemId: 'sku-1', quantity: 2,
  payment: { id: 'entry-1', description: 'Order payment', walletId: 'wallet-1', amount: { minorUnits: '100', currency: 'USD' } },
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

  it('releases a successfully reserved item when the saga compensates', async () => {
    const reserve = vi.fn().mockResolvedValue({ id: 'reservation-1' });
    const release = vi.fn().mockResolvedValue(undefined);
    const step = new ReserveInventoryStep({ reserve, release } as never);
    const reservationId = await step.execute(context);

    await step.compensate(context, reservationId);

    expect(release).toHaveBeenCalledWith('tenant-1', 'reservation-1');
  });

  it('uses a stable ledger idempotency key after a post commits but its response is lost', async () => {
    const postWalletPayment = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValue({ id: 'entry-1' });
    const step = new SettleLedgerPaymentStep({ postWalletPayment } as never);
    const paymentContext = { ...context, ledgerEntryId: undefined };
    await expect(step.execute(paymentContext)).rejects.toThrow('response lost');
    await expect(step.execute(paymentContext)).resolves.toBe('entry-1');
    expect(postWalletPayment.mock.calls[0]![1]).toEqual(postWalletPayment.mock.calls[1]![1]);
    expect(postWalletPayment.mock.calls[0]![1]).toMatchObject({ scope: 'fulfillment:saga:post', key: 'saga-1' });
  });

  it('moves the order to payment settlement before posting and compensates a posted entry', async () => {
    const onPaymentStarting = vi.fn().mockResolvedValue(undefined);
    const postWalletPayment = vi.fn().mockResolvedValue({ id: 'entry-1' });
    const reverse = vi.fn().mockResolvedValue({ id: 'entry-1:reversal' });
    const ledger = { postWalletPayment, reverse };
    const step = new SettleLedgerPaymentStep(ledger as never);
    const paymentContext = { ...context, onPaymentStarting };

    await expect(step.execute(paymentContext)).resolves.toBe('entry-1');
    expect(onPaymentStarting).toHaveBeenCalledOnce();
    expect(paymentContext.ledgerEntryId).toBe('entry-1');
    await step.compensate(paymentContext, 'entry-1');
    expect(reverse).toHaveBeenCalledWith('entry-1', 'entry-1:reversal', 'tenant-1', {
      scope: 'fulfillment:saga:reverse', key: 'saga-1', fingerprint: 'entry-1',
    });
  });

  it('preserves an explicit payment posting timestamp', async () => {
    const postWalletPayment = vi.fn().mockResolvedValue({ id: 'entry-1' });
    const step = new SettleLedgerPaymentStep({ postWalletPayment } as never);
    const postedAt = '2026-01-02T03:04:05.000Z';

    await step.execute({ ...context, payment: { ...context.payment, postedAt } });

    expect(postWalletPayment.mock.calls[0]?.[0].postedAt).toBe(postedAt);
  });

  it('releases a reservation during compensation and requires a reservation to release', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const step = new ReleaseInventoryStep({ release } as never);
    await expect(step.execute({ ...context, reservationId: 'reservation-1' })).resolves.toBe('reservation-1');
    expect(release).toHaveBeenCalledWith('tenant-1', 'reservation-1');
    await expect(step.execute({ ...context, reservationId: undefined })).rejects.toThrow('Inventory reservation is missing');
    await expect(step.compensate(context, 'unused')).resolves.toBeUndefined();
  });

  it('requires a ledger entry before reversal and reverses the specified entry', async () => {
    const reverse = vi.fn().mockResolvedValue(undefined);
    const step = new ReverseLedgerEntryStep({ reverse } as never);
    await expect(step.execute({ ...context, ledgerEntryId: undefined })).rejects.toThrow('Ledger entry is missing');
    await expect(step.execute({ ...context, ledgerEntryId: 'entry-2' })).resolves.toBe('entry-2');
    expect(reverse).toHaveBeenCalledWith('entry-2', 'entry-2:reversal', 'tenant-1', {
      scope: 'fulfillment:saga:reverse', key: 'saga-1', fingerprint: 'entry-2',
    });
    await expect(step.compensate(context, 'unused')).resolves.toBeUndefined();
  });
});
