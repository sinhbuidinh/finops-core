import { DomainConflictError, DomainValidationError } from '../../../shared/domain/domain-error.js';
import { Order } from './order.js';
import { OrderStateMachine } from './order-state-machine.js';

describe('Order', () => {
  it('starts in DRAFT and can follow the successful lifecycle', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    expect(order.state).toBe('DRAFT');

    for (const state of ['PENDING_APPROVAL', 'APPROVED', 'RESERVING_STOCK', 'SETTLING_PAYMENT', 'CONFIRMED'] as const) {
      order.transitionTo(state);
    }
    expect(order.state).toBe('CONFIRMED');
  });

  it('allows a draft order to be approved without an approval workflow', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    order.transitionTo('APPROVED');
    expect(order.state).toBe('APPROVED');
  });

  it('rejects invalid transitions without changing aggregate state', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    expect(() => order.transitionTo('CONFIRMED')).toThrow(DomainConflictError);
    expect(order.state).toBe('DRAFT');
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it('records state change events and clears them when pulled', () => {
    const order = Order.create({ id: 'order-1', tenantId: 'tenant-1' });
    order.transitionTo('PENDING_APPROVAL');
    order.transitionTo('APPROVED');

    const events = order.pullDomainEvents();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      eventName: 'OrderStateChanged',
      payload: { orderId: 'order-1', previousState: 'DRAFT', state: 'PENDING_APPROVAL' },
    });
    expect(events[1]).toMatchObject({
      eventName: 'OrderStateChanged',
      payload: { orderId: 'order-1', previousState: 'PENDING_APPROVAL', state: 'APPROVED' },
    });
    expect(order.pullDomainEvents()).toEqual([]);
  });

  it.each(['CONFIRMED', 'CANCELLED', 'FAILED'] as const)('%s is terminal', (terminal) => {
    expect(OrderStateMachine.canTransition(terminal, 'DRAFT')).toBe(false);
  });

  it('rejects missing identity', () => {
    expect(() => Order.create({ id: '', tenantId: 'tenant-1' })).toThrow(DomainValidationError);
  });
});
