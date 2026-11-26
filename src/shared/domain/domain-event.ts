export interface DomainEvent<TPayload extends object = Record<string, unknown>> {
  readonly eventId: string;
  readonly eventName: string;
  readonly occurredAt: Date;
  readonly payload: Readonly<TPayload>;
}
