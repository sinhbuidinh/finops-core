# ADR-004: Orchestration Saga for Order Fulfillment and Compensation

- **Status**: Accepted
- **Date**: 2026-11-25
- **Context**: Order fulfillment spans multiple steps—reserving inventory, posting ledger entries, and updating order status—where a later step can fail after an earlier step has already succeeded, requiring deterministic rollback/compensation.

## Decision

We will use an **Orchestration Saga** (`OrderFulfillmentSaga`) composed of discrete `SagaStep` units (`execute` and `compensate`) coordinated by an orchestrator/worker:

1. Each step encapsulates a focused action and its corresponding compensating action (e.g., reserve inventory -> release inventory; post ledger entry -> post reversing entry).
2. If a step fails after retries are exhausted, the orchestrator executes compensation steps in reverse order for already-completed steps and transitions the order to a clear terminal/failed state.
3. All step executions and compensations are designed to be **idempotent** to survive worker retries or duplicate messages.

## Alternatives Considered

1. **Pure Event Choreography (Chain of Autonomous Event Listeners)**: Each service/handler reacts to events and emits follow-up events without a central coordinator. As workflows and failure branches grow, end-to-end flow and compensation order become harder to trace and reason about.
2. **Long-Lived Distributed Database Locks Across All Steps**: Holding database transactions open across external calls or multi-step workflows hurts connection pool health, throughput, and lock contention.

## Consequences

### Positive
* Centralizes step sequencing and reverse-order compensation logic in one readable place.
* Avoids long-held database locks while preserving eventual consistency and clear failure recovery.
* Makes adding or replacing a fulfillment step straightforward (supports OCP).

### Negative / Trade-offs
* Orchestrator logic must be carefully tested for partial failure and retry edge cases.
* Requires every step and compensation action to be idempotent.