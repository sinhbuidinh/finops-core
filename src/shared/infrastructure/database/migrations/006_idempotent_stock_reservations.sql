ALTER TABLE stock_reservations
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS stock_reservations_idempotency_key_idx
  ON stock_reservations (idempotency_key)
  WHERE idempotency_key IS NOT NULL;
