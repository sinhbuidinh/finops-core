# ADR-001: Modular Monolith with Hexagonal Architecture (Ports & Adapters)

- **Status**: Accepted
- **Date**: 2026-11-25
- **Context**: `commerce-finops-core` consists of four tightly coupled business capabilities (`tenant-quota`, `approval-workflow`, `fulfillment-saga`, `ledger`) that must maintain strong consistency on financial postings, inventory reservations, and order state transitions.

## Decision

We will structure the system as a **Modular Monolith** in NestJS, partitioning code by bounded context (`src/modules/*`) and applying **Hexagonal (Ports & Adapters)** layering inside each module (`domain/`, `application/`, `infrastructure/`, `presentation/`).

- **Domain Layer**: Pure TypeScript entities, value objects, state machines, domain events, and port interfaces. Zero imports from `@nestjs/*`, ORMs, message brokers, or HTTP layers.
- **Application Layer**: Use cases and orchestration logic that coordinate ports and transaction boundaries.
- **Infrastructure Layer**: Concrete adapters for PostgreSQL, Redis, queues, and external gateways.
- **Presentation Layer**: Thin HTTP controllers, DTOs, guards, and interceptors.

Cross-module communication happens through explicit application ports/events rather than reaching into another module's internal repositories or database tables directly.

## Alternatives Considered

1. **Microservices from Day One**: Splitting into separate services for tenants, workflows, orders, and ledger introduces network latency, distributed transaction complexity, operational overhead, and deployment friction before domain boundaries stabilize.
2. **Classic Layered Architecture (Controller -> Service -> Repository with Anemic Models)**: Often leads to business logic leaking into controllers or ORM entities, making rules harder to test in isolation and coupling domain behavior to framework decorators.

## Consequences

### Positive
* Single deployment unit with shared ACID database transactions where needed and clear bounded contexts that can be extracted later if scale or team structure demands it.
* High unit-test speed and clarity because domain rules do not depend on NestJS runtime or database drivers.
* Enforces SOLID boundaries (especially SRP and DIP) across the codebase.

### Negative / Trade-offs
* Requires team/contributor discipline (and lint/boundary rules) to prevent cross-module shortcut imports.
* All modules scale together within the same runtime process unless specific background workers are separated later.