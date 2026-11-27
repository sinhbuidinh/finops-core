# Initial project scaffold

```sh
docker run --rm -v "${PWD}:/app" -w /app node:20-alpine npx -y @nestjs/cli new . --package-manager npm
```

# Start PostgreSQL and Redis

```sh
docker compose up -d postgres redis
```

# Apply the reliability tables before starting the API

```sh
docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U postgres -d finops_core < src/shared/infrastructure/database/migrations/001_reliability_tables.sql
```

# Build and start the API

```sh
docker compose up -d --build api
```

# Check log NestJS

```sh
docker logs -f nest_api
```

The database connection uses `DATABASE_URL` when set; otherwise it reads `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` (defaults: `localhost`, `5432`, `postgres`, `postgres`, and `finops_core`).

`IdempotencyStore.acquire()` claims `(scope, key)` atomically and reports whether the caller owns the key, should replay a stored response, is already in progress, or reused the key with another fingerprint. Complete successful requests with `complete()` and call `release()` when a failed request should be retried. Expired rows are cleaned up periodically.

For transactional events, call `OutboxRepository.enqueue()` with the same `PoolClient` used for domain writes. Register delivery handlers with `OutboxEventBus.subscribe(eventName, handler)`; a delivery is marked published only after all matching handlers resolve. Failures retry with capped exponential backoff and then move to `DEAD_LETTER` for inspection.

Outbox delivery allows three total attempts by default (the initial delivery plus two retries). Set `OUTBOX_MAX_ATTEMPTS` to a positive integer to change the limit; for example, `OUTBOX_MAX_ATTEMPTS=5` permits five total delivery attempts. The relay and order creation require the `outbox_events` table, so apply the reliability migration above to the same PostgreSQL database configured by `DATABASE_URL` (or the `DB_*` settings).
