# Ledger balance and wallet posting flow

## Current balance pattern

The ledger uses an append-only, double-entry journal with a synchronously maintained balance projection (pattern 2). `ledger_account_balances` stores a signed normal balance per `(account_id, currency)`. A posting transaction writes the journal header and lines, updates each affected balance row, completes its idempotency record, then commits. A balance read selects the account and its projection; it does not aggregate journal history. Migration `012_ledger_account_balances.sql` initializes the projection from existing lines.

For assets and expenses, debits increase the normal balance and credits reduce it. Liabilities, equity, and revenue use the opposite sign. Wallet accounts are created as assets, so funding debits increase the spendable balance and payment credits reduce it.

## Wallet posting flow

1. The tenant-scoped API supplies an idempotency key and journal entry.
2. In one PostgreSQL transaction, the repository claims/locks the idempotency row, loads and locks all referenced ledger account rows in account ID order, and verifies tenant ownership (with the platform clearing account exception).
3. For each wallet account and currency in the entry, the repository computes the signed balance delta. If the resulting normal balance would be below zero, it fails with `INSUFFICIENT_WALLET_BALANCE` before inserting journal rows.
4. The repository inserts the immutable journal header and lines and upserts balance deltas in a stable account/currency order. The database balance trigger and foreign keys remain a second layer of validation.
5. The idempotency response and ledger changes commit together. Any error rolls back the journal, balance changes, and idempotency claim.

Wallet account row locks serialize competing spend attempts, including when the balance row for a currency does not exist yet. Therefore two individually valid requests cannot both spend the same starting balance. The lock also serializes funding and spending for that wallet.

## Known issues and failure modes to maintain

- **Reversal may be rejected after funds were spent.** A reversal of wallet funding reduces the wallet asset balance and is subject to the same nonnegative check. If the wallet has already spent those funds, reversal fails with `INSUFFICIENT_WALLET_BALANCE`. Resolve this with a defined business policy: disallow/hold spending of reversible funds, create a receivable/negative wallet balance with explicit collection semantics, or require a compensating recovery flow. Do not bypass the guard silently.
- **Non-wallet accounts may have negative balances.** The new guard applies only to accounts registered in `wallets`. Other asset accounts can still go negative; decide account-specific minimum-balance rules before using them for authorization.
- **This is not a general overdraft, reservation, or authorization system.** There is no separate hold/reservation state. A payment is authorized only when posted; callers needing preauthorization need an atomic reservation model.
- **Hot accounts can contend.** Account rows are locked for each posting to protect wallet checks, and balance rows are updated synchronously. A high-volume shared wallet or clearing account can serialize writes and increase latency. Monitor lock waits; partition business flows/account design where feasible, or design a reservation/authorization ledger before adding unsafe read-side bypasses.
- **Projection drift needs operational recovery.** Journal rows are the accounting source of truth, but balance reads trust the projection. Add a reconciliation job that recomputes signed balances from journal lines, reports mismatches, and repairs them under a controlled maintenance procedure. Until that exists, restore/replay mistakes can leave balance reads wrong.
- **Integer range differs between layers.** Domain amounts use `bigint`, journal lines use PostgreSQL `BIGINT`, and aggregate balances use `NUMERIC(38,0)`. A single line larger than the database `BIGINT` limit fails at insert and rolls back; validate supported limits at the API boundary or migrate line amounts to `NUMERIC` if larger values are required.
- **Wallet balances are per currency.** A wallet can have multiple currency rows; callers must not sum them into one spendable amount or exchange currencies implicitly.
- **Internal writes without tenant context do not get tenant ownership filtering.** External controller paths pass a tenant ID. Keep repository writes tenant-scoped for request flows; internal/system callers must be reviewed explicitly.

## Verification

`test/integration/ledger-wallet-flow.spec.ts` covers ordinary balance persistence, rejection of an overspend without journal mutation, and concurrent spends against one wallet. These PostgreSQL integration cases run only when `INVENTORY_TEST_DATABASE_URL` is configured; otherwise Vitest skips them. The unit repository tests cover atomic transaction ordering and rollback behavior.
