import { AggregateRoot } from '../../../shared/domain/aggregate-root.js';
import { DomainValidationError } from '../../../shared/domain/domain-error.js';
import type { DomainEvent } from '../../../shared/domain/domain-event.js';
import { OrderState, OrderStateMachine, type OrderState as OrderStateValue } from './order-state-machine.js';

interface OrderStateChangedPayload {
  orderId: string;
  previousState: OrderStateValue;
  state: OrderStateValue;
}

function orderStateChangedEvent(payload: OrderStateChangedPayload): DomainEvent<OrderStateChangedPayload> {
  return {
    eventId: globalThis.crypto.randomUUID(),
    eventName: 'OrderStateChanged',
    occurredAt: new Date(),
    payload,
  };
}

export interface OrderInput {
  id: string;
  tenantId: string;
  state?: OrderStateValue;
}

/** Order lifecycle aggregate. All state changes pass through its state machine. */
export class Order extends AggregateRoot<string> {
  private constructor(
    id: string,
    readonly tenantId: string,
    private currentState: OrderStateValue,
  ) {
    super(id);
  }

  static create(input: OrderInput): Order {
    if (!input.id.trim() || !input.tenantId.trim()) {
      throw new DomainValidationError('Order id and tenant id are required', 'INVALID_ORDER');
    }
    return new Order(input.id, input.tenantId, input.state ?? OrderState.DRAFT);
  }

  get state(): OrderStateValue {
    return this.currentState;
  }

  transitionTo(next: OrderStateValue): void {
    const previousState = this.currentState;
    this.currentState = OrderStateMachine.transition(this.currentState, next);
    this.addDomainEvent(orderStateChangedEvent({
      orderId: this.id,
      previousState,
      state: this.currentState,
    }));
  }
}
