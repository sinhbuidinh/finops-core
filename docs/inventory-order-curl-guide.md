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

The token must be an HS256 JWT signed with the API's `AUTH_JWT_SECRET`, with a non-empty `sub`, a future `exp`, and either a `tenant_id` claim or a `tenant_ids` array. Configure the same secret (at least 32 bytes) in the API. If your identity provider issues a different algorithm or token format, connect its verifier instead of adapting clients to trust an unsigned tenant header. Set `AUTH_JWT_ISSUER` and `AUTH_JWT_AUDIENCE` when those claims are part of your token contract. For a user with multiple tenant memberships, send `X-Tenant-Id` to select one; the guard rejects a tenant that is not in the signed membership claims. A user with one membership can omit that header.

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
