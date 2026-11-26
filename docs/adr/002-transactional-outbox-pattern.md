# ADR-002: Transactional Outbox Pattern for Reliable Event Publishing

- **Status**: Accepted
- **Date**: 2026-11-25
- **Context**: When state changes occur in PostgreSQL (such as posting a ledger entry or confirming an order), downstream reactions (triggering saga steps, sending notifications, updating read models, or publishing integration events) must not be lost if the process crashes or the broker/queue is temporarily unavailable after commit.

## Decision

We will implement the **Transactional Outbox Pattern**:

1. Domain state mutations and outbox records (`outbox_events`) are written inside the **same database transaction**.
2. A background relay worker polls pending outbox records using row-level locking (`FOR UPDATE SKIP LOCKED`), dispatches them to the queue/event bus, and marks them `PUBLISHED`.
3. Failed deliveries retry with exponential backoff and transition to a `DEAD_LETTER` / failed state after max attempts for inspection and replay.
4. Event consumers track processed `eventId` values so duplicate deliveries remain **idempotent**.

## Alternatives Considered

1. **Direct Event Emit / Queue Publish Inside Request or After Commit**: Publishing before commit risks emitting events for rolled-back transactions; publishing after commit without persistence risks silent event loss if the app crashes between DB commit and broker publish.
2. **Distributed Two-Phase Commit (2PC / XA) Across DB and Broker**: Adds operational complexity, lock contention, and lower throughput compared to a local DB transaction plus outbox relay.

## Consequences

### Positive
* Guarantees at-least-once event delivery tied atomically to database state commits.
* Decouples request latency from external broker availability.
* Provides an auditable log of emitted domain/integration events and retry states.

### Negative / Trade-offs
* Requires at-least-once delivery semantics, meaning downstream consumers must be idempotent.
* Adds background worker polling/scheduling and table maintenance/archival considerations.