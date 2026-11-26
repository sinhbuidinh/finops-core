import type { DomainEvent } from './domain-event.js';

export abstract class AggregateRoot<TId = string> {
  private readonly domainEvents: DomainEvent[] = [];

  protected constructor(readonly id: TId) {}

  protected addDomainEvent(event: DomainEvent): void {
    this.domainEvents.push(event);
  }

  /** Returns and removes events raised since the previous pull. */
  pullDomainEvents(): DomainEvent[] {
    return this.domainEvents.splice(0);
  }
}
