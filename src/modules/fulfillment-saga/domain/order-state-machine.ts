import { DomainConflictError } from '../../../shared/domain/domain-error.js';

export const ORDER_STATES = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'RESERVING_STOCK',
  'SETTLING_PAYMENT',
  'CONFIRMED',
  'CANCELLED',
  'FAILED',
] as const;

export type OrderState = (typeof ORDER_STATES)[number];

const TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  DRAFT: ['PENDING_APPROVAL', 'APPROVED', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'CANCELLED'],
  APPROVED: ['RESERVING_STOCK', 'CANCELLED', 'FAILED'],
  RESERVING_STOCK: ['SETTLING_PAYMENT', 'CANCELLED', 'FAILED'],
  SETTLING_PAYMENT: ['CONFIRMED', 'FAILED'],
  CONFIRMED: [],
  CANCELLED: [],
  FAILED: [],
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
