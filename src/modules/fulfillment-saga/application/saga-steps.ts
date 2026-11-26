import type { InventoryService } from '../../inventory/inventory.service.js';
import { JournalEntry } from '../../ledger/domain/journal-entry.js';
import { Money } from '../../../shared/domain/money.js';
import type { LedgerPostingPort } from './ledger-posting.port.js';
import type { SagaStep } from './saga-step.js';

export interface FulfillmentContext {
  readonly sagaId: string;
  readonly orderId: string;
  readonly inventoryItemId: string;
  readonly quantity: number;
  readonly payment: {
    readonly id: string;
    readonly description: string;
    readonly lines: readonly { readonly accountId: string; readonly side: 'DEBIT' | 'CREDIT'; readonly amount: { readonly minorUnits: string; readonly currency: string }; readonly memo?: string }[];
  };
  reservationId?: string;
  ledgerEntryId?: string;
}

export class ReserveInventoryStep implements SagaStep<FulfillmentContext, string> {
  readonly name = 'reserve-inventory';
  constructor(private readonly inventory: InventoryService) {}
  async execute(context: FulfillmentContext): Promise<string> {
    const reservation = await this.inventory.reserve(context.inventoryItemId, context.quantity);
    context.reservationId = reservation.id;
    return reservation.id;
  }
  async compensate(_context: FulfillmentContext, reservationId: string): Promise<void> {
    await new ReleaseInventoryStep(this.inventory).execute({ ..._context, reservationId });
  }
}

export class SettleLedgerPaymentStep implements SagaStep<FulfillmentContext, string> {
  readonly name = 'settle-ledger-payment';
  constructor(private readonly ledger: LedgerPostingPort) {}
  async execute(context: FulfillmentContext): Promise<string> {
    const entry = JournalEntry.create({
      id: context.payment.id,
      description: context.payment.description,
      lines: context.payment.lines.map((line) => ({ ...line, amount: Money.fromMinorUnits(BigInt(line.amount.minorUnits), line.amount.currency) })),
    });
    const posted = await this.ledger.post(entry, { scope: 'fulfillment:saga:post', key: context.sagaId, fingerprint: context.payment.id });
    context.ledgerEntryId = posted.id;
    return posted.id;
  }
  async compensate(context: FulfillmentContext, entryId: string): Promise<void> {
    await new ReverseLedgerEntryStep(this.ledger).execute({ ...context, ledgerEntryId: entryId });
  }
}

export class ReleaseInventoryStep implements SagaStep<FulfillmentContext, string> {
  readonly name = 'release-inventory';
  constructor(private readonly inventory: InventoryService) {}
  async execute(context: FulfillmentContext): Promise<string> {
    if (!context.reservationId) throw new Error('Inventory reservation is missing');
    await this.inventory.release(context.reservationId);
    return context.reservationId;
  }
  async compensate(): Promise<void> {}
}

export class ReverseLedgerEntryStep implements SagaStep<FulfillmentContext, string> {
  readonly name = 'reverse-ledger-entry';
  constructor(private readonly ledger: LedgerPostingPort) {}
  async execute(context: FulfillmentContext): Promise<string> {
    if (!context.ledgerEntryId) throw new Error('Ledger entry is missing');
    await this.ledger.reverse(context.ledgerEntryId, `${context.ledgerEntryId}:reversal`, {
      scope: 'fulfillment:saga:reverse', key: context.sagaId, fingerprint: context.ledgerEntryId,
    });
    return context.ledgerEntryId;
  }
  async compensate(): Promise<void> {}
}

