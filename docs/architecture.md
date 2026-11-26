# Architecture Specification — Commerce & FinOps Core

## 1. Overview & Architectural Goals

`commerce-finops-core` is a B2B Multi-Tenant Commerce and Financial Operations backend built on **NestJS**. It combines four bounded contexts into a single deployable **Modular Monolith** with strict **Hexagonal (Ports & Adapters)** boundaries:

1. **Tenant & Quota (`tenant-quota`)**: Multi-tenant isolation, subscription plans, rate limiting, and atomic usage quota enforcement.
2. **Approval Workflow (`approval-workflow`)**: Dynamic rule evaluation, multi-step approval routing, and immutable audit trails for high-value or policy-sensitive actions.
3. **Order & Fulfillment Saga (`fulfillment-saga`)**: Order lifecycle state machine, inventory reservation with concurrency control, and orchestrated compensation on failure.
4. **Double-Entry Ledger (`ledger`)**: Immutable double-entry accounting (`Debit === Credit`), monetary precision, idempotency, and settlement tracking.

### Core Engineering Goals
* **Domain Purity**: Business rules, invariants, and state transitions live in framework-agnostic TypeScript (`domain/`), free of `@nestjs/*`, ORM decorators, or transport types.
* **Data Integrity Under Concurrency**: Prevent double-spending, overselling, and duplicate mutations via idempotency keys, database locks, and transactional outbox delivery.
* **Evolvability (SOLID)**: New payment providers, approval rules, or saga steps can be added without modifying existing core orchestration or domain logic.
* **Operability & Testability**: Fast unit tests for domain/use-cases, isolated integration tests against real PostgreSQL/Redis, structured logging with `correlationId`, and health checks.

---

## 2. High-Level Architecture

### 2.1 Modular Monolith + Hexagonal Layering

Each module is organized into four concentric layers with strict inward dependency direction:

```text
[Presentation / Interfaces] ──► HTTP Controllers, Guards, Interceptors, DTOs
    │
    ▼
[Application Layer] ──► Use Cases, Command/Query Handlers, Saga Orchestrator, Ports
    │
    ▼
[Domain Layer] ──► Entities, Value Objects, State Machines, Domain Events, Policy Interfaces
    ▲
    │ (implements Ports)
[Infrastructure Layer] ──► PostgreSQL/ORM Repositories, Redis Adapters, BullMQ Workers, Outbox Relay
```
Dependency Rule: Inner layers never import from outer layers.
Domain has zero external runtime dependencies beyond standard TypeScript/language primitives.

2.2 End-to-End Request & Event Flow
```sequenceDiagram
    autonumber
    participant Client
    participant API as NestJS API (Guard & Controller)
    participant Quota as Tenant & Quota Module
    participant Order as Fulfillment Saga Module
    participant Workflow as Approval Workflow Module
    participant Ledger as Double-Entry Ledger Module
    participant Outbox as Outbox Relay & Worker

    Client->>API: POST /orders (Idempotency-Key, X-Tenant-Id)
    API->>Quota: Check rate-limit & monthly order quota (Redis + DB)
    Quota-->>API: Allowed (quota consumed)
    API->>Order: PlaceOrderUseCase

    alt Order requires approval (RuleEvaluator)
        Order->>Workflow: Start approval workflow
        Workflow-->>Order: PENDING_APPROVAL + AuditLog
        Order-->>Client: 202 Accepted (PENDING_APPROVAL)
        Note over Workflow: Approver submits decision -> emits OrderApprovedEvent
    end

    Order->>Order: Transition state -> APPROVED (StateMachine)
    Order->>Order: Reserve Inventory (Optimistic/Pessimistic Lock)
    Order->>Ledger: Post balanced Debit/Credit JournalEntry (Idempotent)

    alt Ledger / Settlement fails
        Ledger-->>Order: Failure
        Order->>Order: Compensate (Release Stock & Reverse Hold)
        Order-->>Client: Order FAILED (Compensated)
    else Succeeded
        Order->>Order: Write Domain Event to Outbox Table (Same DB Tx)
        Order-->>Client: 201 Created (CONFIRMED)
        Outbox->>Outbox: Poll & publish events with retry/DLQ
    end
```

## 3. Cross-Cutting Technical Patterns
### 3.1 Monetary Representation (Money Value Object)
* Never use IEEE-754 floating-point numbers (number with decimals) for currency amounts.

* Store minor units (bigint for cents/smallest currency unit) alongside ISO-4217 currency code (USD, VND, JPY).

* Enforce currency equality on arithmetic operations (add, subtract, allocate) in the Money value object.

### 3.2 Idempotency for Mutating Endpoints
- State-changing endpoints (POST /orders, POST /ledger/entries, POST /approvals/:id/decisions) require an Idempotency-Key header.

- Execution flow:

1. Compute request fingerprint (tenantId + method + path + payloadHash).

2. Check idempotency store:

* If COMPLETED with matching fingerprint: return cached response status and body without re-executing business logic.

* If COMPLETED with mismatched fingerprint: return 409 Conflict / 422 Unprocessable Entity.

* If IN_PROGRESS: return 409 Conflict (concurrent duplicate request).

3. Persist response atomically upon completion; release lock on failure if safe to retry.

### 3.3 Transactional Outbox Pattern
* Domain state changes and outbox event records are persisted inside the same database transaction.

* A background relay/worker fetches unpublished outbox rows (FOR UPDATE SKIP LOCKED), publishes them to the message bus/queue, marks them PUBLISHED, and moves repeatedly failing messages to a Dead-Letter state after exponential backoff.

* Downstream consumers remain idempotent by tracking processed eventId values.

### 3.4 Concurrency & Locking Strategy
* **Double-Entry Ledger:** Enforce balanced entries in JournalEntry.create() (sum(DEBIT) === sum(CREDIT)). Use database transactions (SERIALIZABLE or row-level locks on accounts where strict ordering is needed) and unique constraints on (tenant_id, idempotency_key).

* **Inventory Reservation:** Use Optimistic Locking (version column) for low-to-moderate contention SKUs, or pessimistic row locking (SELECT ... FOR UPDATE) / atomic conditional updates (WHERE available_qty >= :qty) for hot SKUs.

* **Quota & Rate Limiting:** Use atomic Redis operations (Lua script or pipeline with TTL) for real-time rate/quota checks, backed by PostgreSQL as the source of truth for subscription plans and billing periods.

### 3.5 Error Handling & Observability
* **Domain / Application Errors:** Represent expected business failures explicitly (e.g., Result<T, DomainError> or typed domain exceptions mapped cleanly in an HTTP Exception Filter) rather than leaking raw ORM/driver errors.

* **Structured Logging:** Use structured JSON logs (pino) enriched with correlationId, tenantId, userId, and orderId via AsyncLocalStorage.

* **Health & Metrics:** Expose /health/live and /health/ready (verifying DB and Redis connectivity) plus Prometheus-compatible metrics if enabled.

## 4. SOLID Principles in Practice
|Principle|Concrete Implementation in This Codebase|
|---------|----------------------------------------|
|Single Responsibility (SRP)|Controllers handle HTTP transport only; Use Cases coordinate one business flow; State Machines validate transitions; Validators enforce domain invariants; Repositories handle persistence.|
|Open/Closed (OCP)|"ApprovalRuleEvaluator implementations (amount threshold| department| risk score) and SagaStep implementations are registered via DI providers without altering existing engine loops."|
|Liskov Substitution (LSP)|"Any implementation of a port (e.g., PaymentGatewayPort, QuotaStorePort, ApproverResolverPort) honors the contract's preconditions, postconditions, and error semantics."|
|Interface Segregation (ISP)|"Split large capabilities into focused ports (e.g., QuotaReaderPort vs. QuotaUsagePort, LedgerQueryPort vs. LedgerPostingPort) so consumers only depend on methods they use."|
|Dependency Inversion (DIP)|Application and Domain layers define port interfaces and injection tokens; Infrastructure provides concrete implementations bound in NestJS module providers.|

## 5. Directory & Module Layout

```layout
src/
├── shared/
│   ├── domain/                  # Base Entity, AggregateRoot, DomainEvent, Money VO, Result, Errors
│   ├── application/             # UnitOfWork port, Clock port, Idempotency port, EventPublisher port
│   └── infrastructure/
│       ├── config/              # Typed env validation (Zod / Joi / ConfigModule)
│       ├── database/            # Prisma/TypeORM client, UnitOfWork, migrations
│       ├── idempotency/         # Idempotency interceptor & DB/Redis store
│       ├── outbox/              # Outbox entity, repository, relay processor
│       ├── observability/       # AsyncLocalStorage context, correlationId middleware, logger, health
│       └── presentation/        # Global HTTP exception filter, standard error envelope
├── modules/
│   ├── tenant-quota/            # Tenants, plans, rate limits, quota evaluation & consumption
│   ├── approval-workflow/       # Dynamic rules, approval instances, decisions, audit trail
│   ├── fulfillment-saga/        # Orders, state machine, inventory reservation, saga & compensation
│   └── ledger/                  # Chart of accounts, balanced journal entries, account balances
├── app.module.ts
└── main.ts
```

## 6. Testing Strategy
* **Unit Tests (test/unit/):** Test pure domain entities, Money arithmetic, DoubleEntryValidator, OrderStateMachine, ApprovalRuleEvaluators, and Use Cases with mocked ports. Fast, deterministic, no DB/Redis required.

* **Integration Tests (test/integration/):** Test repositories, optimistic/pessimistic locking, idempotency store, and transactional outbox against real PostgreSQL and Redis instances (via Docker Compose or Testcontainers).

* **End-to-End Tests (test/e2e/):** Exercise HTTP endpoints across full business flows (quota check -> approval -> saga -> ledger -> outbox), including failure/compensation paths.

## 7. Architecture Decision Records (ADRs)
Maintain concise decision logs under docs/adr/:

* **docs/adr/001-modular-monolith-hexagonal.md** — Why modular monolith with strict module boundaries before microservices.

* **docs/adr/002-transactional-outbox.md** — Why outbox table + relay is used instead of direct in-memory/broker emits inside DB transactions.

* **docs/adr/003-double-entry-ledger-immutability.md** — Why ledger entries are append-only/reversals-only with integer minor units.

* **docs/adr/004-orchestration-saga.md** — Why a centralized saga orchestrator is used for order fulfillment and compensation.
