import { OrdersController } from './orders.controller.js';

describe('OrdersController', () => {
  it('forwards order requests with the authenticated tenant and idempotency key', async () => {
    const orders = {
      createOrder: vi.fn().mockResolvedValue({ id: 'order-1' }),
      getOrder: vi.fn().mockResolvedValue({ id: 'order-1' }),
      cancelOrder: vi.fn().mockResolvedValue({ id: 'order-1' }),
    };
    const controller = new OrdersController(orders as never);
    const body = { inventoryItemId: 'sku-1', quantity: 2, payment: { id: 'entry-1', description: 'payment', lines: [] } };

    await expect(controller.create('tenant-1', 'create-key', body)).resolves.toEqual({ id: 'order-1' });
    expect(orders.createOrder).toHaveBeenCalledWith({ ...body, tenantId: 'tenant-1' }, 'create-key');
    await expect(controller.get('tenant-1', 'order-1')).resolves.toEqual({ id: 'order-1' });
    expect(orders.getOrder).toHaveBeenCalledWith('tenant-1', 'order-1');
    await expect(controller.cancel('tenant-1', 'order-1', 'cancel-key')).resolves.toEqual({ id: 'order-1' });
    expect(orders.cancelOrder).toHaveBeenCalledWith('tenant-1', 'order-1', 'cancel-key');
  });
});
