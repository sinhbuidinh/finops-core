# ADR-003: Append-Only Double-Entry Ledger with Integer Minor Units

- **Status**: Accepted
- **Date**: 2026-11-25
- **Context**: Financial balances, order settlements, and refunds require strict auditability, zero floating-point rounding drift, and clear traceability for every fund movement.

## Decision

We will model financial movements using an **append-only Double-Entry Ledger** with integer minor units:

1. Every `JournalEntry` must contain balanced `DEBIT` and `CREDIT` lines (`sum(DEBIT) === sum(CREDIT)`) for the same currency, validated in the domain layer before persistence.
2. Monetary amounts are represented in minor units (`bigint`, e.g., cents) paired with an explicit currency code (`Money` value object).
3. Posted journal entries are **immutable**—corrections or refunds are recorded as new reversing or offsetting `JournalEntry` records rather than mutating or deleting historical rows.
4. Ledger mutations enforce an `Idempotency-Key` per tenant and operate within strict database transactions.

## Alternatives Considered

1. **Mutating a Single `balance` Column on Account/User/Order Records**: Simple at first, but loses historical audit trails, makes discrepancies hard to reconcile, and easily causes race conditions or partial updates.
2. **Using Floating-Point Numbers (`number` / `float` / `double`) for Currency**: Prone to binary representation precision errors (`0.1 + 0.2 !== 0.3`), unacceptable for financial calculations.

## Consequences

### Positive
* Built-in mathematical invariant (`Debit === Credit`) catches accounting bugs early.
* Complete, tamper-evident audit trail of every debit, credit, and reversal.
* Eliminates floating-point precision bugs.

### Negative / Trade-offs
* More verbose than updating a single balance field; requires careful account chart design and balance query/projection strategies.
* Reversals require explicit compensating entries rather than in-place edits.