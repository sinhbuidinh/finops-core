# Inventory and order flow with curl

This guide walks through the current API from adding stock to placing and tracking an order. Inventory and order routes require a signed bearer token. The API derives the tenant from the token; a client cannot choose an arbitrary tenant in the request body.

## 1. Start the API and set example values

Start PostgreSQL and the API, apply migrations, then set a base URL. The examples use Bash-compatible shell syntax; replace the IDs and payment details for your environment.

```sh
npm run db:migrate
npm run start:dev
```

In another terminal:

```sh
BASE_URL=http://localhost:3000
TENANT_ID=tenant-1
SKU=sku-1
TOKEN=<access-token-from-your-auth-provider>
```

Sign in through `POST /auth/login` with JSON `{"username":"...","password":"..."}`. Run `npm run db:migrate`, set an `AUTH_JWT_SECRET` of at least 32 bytes, and configure `AUTH_BOOTSTRAP_TOKEN`. Call `POST /auth/bootstrap` with that token in `X-Bootstrap-Token` and a username/password (at least 12 characters) to create the single super administrator. Regular users may already exist, but bootstrap returns a conflict once a super administrator account exists. After bootstrap, remove `AUTH_BOOTSTRAP_TOKEN`.

For the first administrator, configure the secret values before starting the API and use:

```sh
curl -i -X POST http://localhost:3000/auth/bootstrap \
  -H "X-Bootstrap-Token: $AUTH_BOOTSTRAP_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin@example.com","password":"use-a-long-unique-password"}'
```

Sign in to receive a token:

```sh
curl -i -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin@example.com","password":"use-a-long-unique-password"}'
```

A super administrator can create users through `POST /auth/users`. Roles are assigned per tenant, so the same account can have different roles in different tenants. The built-in role list is `tenant_admin`, `finance_manager`, `approver`, and `operator`; `super_admin` is a global role and has no tenant assignments. `tenant_admin` can list users and update their role in that tenant. Set `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE` when required; these claims are included in login tokens when configured.

For the examples below, log in as the super administrator. These commands use `jq` to read `accessToken` from the JSON response:

```sh
ADMIN_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin@example.com","password":"use-a-long-unique-password"}' | jq -r .accessToken)
```

Create a tenant administrator for one tenant:

```sh
curl -i -X POST "$BASE_URL/auth/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"one-tenant@example.com","password":"a-unique-password-123","tenants":[{"tenantId":"tenant-1","role":"tenant_admin"}]}'
```

Create a user with a different role in each of two tenants:

```sh
curl -i -X POST "$BASE_URL/auth/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"multi-tenant@example.com","password":"another-unique-password-123","tenants":[{"tenantId":"tenant-1","role":"approver"},{"tenantId":"tenant-2","role":"finance_manager"}]}'
```

Each regular user logs in separately with `POST /auth/login`. Use the returned token with a tenant ID they are assigned to; for a multi-tenant user, select the active tenant on each request with `X-Tenant-Id`:

```sh
USER_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"multi-tenant@example.com","password":"another-unique-password-123"}' | jq -r .accessToken)

curl -i "$BASE_URL/inventory/items/$SKU" \
  -H "Authorization: Bearer $USER_TOKEN" \
  -H 'X-Tenant-Id: tenant-2'
```

Requests for an unassigned tenant are rejected. Super administrators can select any tenant and must also send `X-Tenant-Id` for tenant-scoped requests.

After signing in as the one-tenant administrator, list that tenant's users and change a user's role within that tenant:

```sh
TENANT_ADMIN_TOKEN=$(curl -s -X POST "$BASE_URL/auth/login" \
  -H 'Content-Type: application/json' \
  -d '{"username":"one-tenant@example.com","password":"a-unique-password-123"}' | jq -r .accessToken)

curl -i "$BASE_URL/auth/tenants/tenant-1/users" \
  -H "Authorization: Bearer $TENANT_ADMIN_TOKEN"

curl -i -X PATCH "$BASE_URL/auth/tenants/tenant-1/users/<user-id>" \
  -H "Authorization: Bearer $TENANT_ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"role":"approver"}'
```

The list and update routes return 403 unless the caller is a `tenant_admin` of that tenant or a `super_admin`. The role update changes only that tenant assignment.

Every request reloads the account and tenant memberships from PostgreSQL. Disabled or deleted accounts lose access immediately.

## 2. Create inventory for the tenant

`POST /inventory/items` creates the tenant's stock record. The SKU can also exist under a different tenant with a separate quantity.

```sh
curl -i -X POST "$BASE_URL/inventory/items" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"id":"sku-1","totalQty":25}'
```

Expected response fields include `tenantId`, `id`, `totalQty`, `reservedQty`, and `availableQty`. A duplicate `(tenantId, id)` returns a conflict; use a different SKU or tenant.

## 3. Check tenant inventory

```sh
curl -i "$BASE_URL/inventory/items/$SKU" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID"
```

The item lookup is scoped to the authenticated tenant. An item belonging to another tenant is not visible and returns not found.

## 4. Optional: make a direct stock reservation

Order creation reserves inventory automatically. Usually skip this step before placing an order; a manual reservation reduces the stock available to orders until it is released.

```sh
curl -i -X POST "$BASE_URL/inventory/items/$SKU/reservations" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H 'Content-Type: application/json' \
  -d '{"quantity":2}'
```

Copy the returned reservation `id` to release it:

```sh
RESERVATION_ID=<reservation-id-from-response>
curl -i -X POST "$BASE_URL/inventory/reservations/$RESERVATION_ID/release" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID"
```

The release route scopes the reservation by tenant. Releasing an unknown reservation or one from a different tenant returns not found.

## 5. Prepare ledger accounts for payment

The fulfillment saga posts the supplied payment as a balanced journal entry. This app has no HTTP endpoint to create ledger accounts, so create the account IDs once in PostgreSQL (or use accounts already provisioned in your database):

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO ledger_accounts (account_id, name, type) VALUES
  ('cash', 'Cash', 'ASSET'),
  ('sales-revenue', 'Sales revenue', 'REVENUE')
ON CONFLICT (account_id) DO NOTHING;
SQL
```

The following order example debits cash and credits sales revenue by 1,000 USD minor units (USD cents).

## 6. Create the order

Send a unique `Idempotency-Key` for this create request. If the client retries the same request after a network issue, reuse that key and the API replays the original response. Use a new key for a different order.

```sh
curl -i -X POST "$BASE_URL/orders" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: order-tenant-1-001' \
  -d '{
    "inventoryItemId":"sku-1",
    "quantity":2,
    "payment":{
      "id":"payment-tenant-1-001",
      "description":"Payment for order",
      "lines":[
        {"accountId":"cash","side":"DEBIT","amount":{"minorUnits":"1000","currency":"USD"}},
        {"accountId":"sales-revenue","side":"CREDIT","amount":{"minorUnits":"1000","currency":"USD"}}
      ]
    }
  }'
```

The API responds with `202 Accepted` and an order object containing `id`, `tenantId`, `state`, and `sagaId`. Copy the order ID from the response:

```sh
ORDER_ID=<id-from-order-response>
```

The initial response can say `APPROVED`. A background worker then moves the order through `RESERVING_STOCK` and `SETTLING_PAYMENT` to `CONFIRMED`. Those intermediate states can pass quickly.

## 7. Poll for order status and verify stock

```sh
curl -i "$BASE_URL/orders/$ORDER_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID"
curl -i "$BASE_URL/inventory/items/$SKU" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID"
```

When confirmed, the inventory response should show `reservedQty` increased by the order quantity and `availableQty` decreased by that amount. If a later saga step fails after reservation, compensation releases the reservation. The order eventually becomes `FAILED` after retries are exhausted.

The order GET response currently includes its state and timestamps, but not the saga's detailed `last_error`. For a failed saga's reason, inspect `fulfillment_saga_jobs.last_error` in PostgreSQL:

```sh
psql "$DATABASE_URL" -c "SELECT state, attempts, last_error FROM fulfillment_saga_jobs WHERE saga_id = '<saga-id-from-order-response>';"
```

## 8. Cancel an order before fulfillment starts

Cancellation is accepted only while the order is still `APPROVED` and its saga job remains pending. The worker may claim the job immediately, so cancellation can return a conflict if fulfillment has already started.

```sh
curl -i -X POST "$BASE_URL/orders/$ORDER_ID/cancel" \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-Tenant-Id: $TENANT_ID" \
  -H 'Idempotency-Key: cancel-order-tenant-1-001'
```

Use a unique key for each cancellation request and reuse it only when retrying that same request.

## Updates and limits in the current API

- There is no inventory quantity update endpoint, and there is no order edit endpoint. `POST /inventory/items` creates an item; it does not update an existing one. `POST /orders` creates an order; it does not edit one.
- To change an order before fulfillment starts, cancel it and submit a new order with a new idempotency key and order/payment IDs.
- To adjust inventory quantities, the API needs an inventory adjustment endpoint. Do not use the reservation release route to adjust stock; it only reverses a specific reservation.
- Do not reserve inventory manually before creating an order unless you intend to hold that additional quantity separately.
- Creating inventory, reserving, releasing inventory, reading orders, and cancelling orders are scoped to the tenant resolved from the signed token and optional `X-Tenant-Id` selector.
