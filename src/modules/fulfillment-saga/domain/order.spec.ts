import { DomainConflictError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { Order } from './order.js';
import { OrderState, OrderStateMachine } from './order-state-machine.js';

describe('Order', () => {
  it('starts in DRAFT and can follow the successful lifecycle', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    expect(order.state).toBe(OrderState.DRAFT);

    for (const state of [OrderState.PENDING_APPROVAL, OrderState.APPROVED, OrderState.RESERVING_STOCK, OrderState.SETTLING_PAYMENT, OrderState.CONFIRMED]) {
      order.transitionTo(state);
    }
    expect(order.state).toBe(OrderState.CONFIRMED);
  });

  it('allows a draft order to be approved without an approval workflow', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    order.transitionTo(OrderState.APPROVED);
    expect(order.state).toBe(OrderState.APPROVED);
  });

  it('rejects invalid transitions without changing aggregate state', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    expect(() => order.transitionTo(OrderState.CONFIRMED)).toThrow(DomainConflictError);
    expect(order.state).toBe(OrderState.DRAFT);
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it('records state change events and clears them when pulled', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    order.transitionTo(OrderState.PENDING_APPROVAL);
    order.transitionTo(OrderState.APPROVED);

    const events = order.pullDomainEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventName: 'OrderStateChanged',
      payload: { orderId: 'order-1', previousState: OrderState.DRAFT, state: OrderState.PENDING_APPROVAL },
    });
    expect(events[1]).toMatchObject({
      eventName: 'OrderStateChanged',
      payload: { orderId: 'order-1', previousState: OrderState.PENDING_APPROVAL, state: OrderState.APPROVED },
    });
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it.each([OrderState.CONFIRMED, OrderState.CANCELLED, OrderState.FAILED])('%s is terminal', (terminal) => {
    expect(OrderStateMachine.canTransition(terminal, OrderState.DRAFT)).toBe(false);
  });

  it('allows cancellation before fulfillment and failure after payment settlement starts', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    order.transitionTo(OrderState.CANCELLED);
    expect(order.state).toBe(OrderState.CANCELLED);

    const failed = Order.create({ id: 'order-2', tenantId: 'tenant-1', state: OrderState.SETTLING_PAYMENT });
    failed.transitionTo(OrderState.FAILED);
    expect(failed.state).toBe(OrderState.FAILED);
  });

  it('rejects missing identity', () => {
    expect(() => Order.create({ id: '', tenantId: 'tenant-1' })).toThrow(DomainValidationError);
  });
});
