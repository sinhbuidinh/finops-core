import { DomainConflictError } from '../../../shared/domain/domain-error.js';

export const OrderState = {
  DRAFT: 'DRAFT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  RESERVING_STOCK: 'RESERVING_STOCK',
  SETTLING_PAYMENT: 'SETTLING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
} as const;
export const ORDER_STATES = Object.values(OrderState);

export type OrderState = (typeof OrderState)[keyof typeof OrderState];

const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  [OrderState.DRAFT]: [OrderState.PENDING_APPROVAL, OrderState.APPROVED, OrderState.CANCELLED],
  [OrderState.PENDING_APPROVAL]: [OrderState.APPROVED, OrderState.CANCELLED],
  [OrderState.APPROVED]: [OrderState.RESERVING_STOCK, OrderState.CANCELLED, OrderState.FAILED],
  [OrderState.RESERVING_STOCK]: [OrderState.SETTLING_PAYMENT, OrderState.CANCELLED, OrderState.FAILED],
  [OrderState.SETTLING_PAYMENT]: [OrderState.CONFIRMED, OrderState.FAILED],
  [OrderState.CONFIRMED]: [],
  [OrderState.CANCELLED]: [],
  [OrderState.FAILED]: [],
};

/** Defines the legal lifecycle transitions for an order. */
export class OrderStateMachine {
  static canTransition(from: OrderState, to: OrderState): boolean {
    return TRANSITIONS[from].includes(to);
  }

  static transition(from: OrderState, to: OrderState): OrderState {
    if (!this.canTransition(from, to)) {
      throw new DomainConflictError(
        `Order cannot transition from ${from} to ${to}`,
        'INVALID_ORDER_STATE_TRANSITION',
      );
    }
    return to;
  }
}
