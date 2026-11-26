CREATE TABLE IF NOT EXISTS inventory_items (
  item_id TEXT PRIMARY KEY,
  total_qty INTEGER NOT NULL CHECK (total_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0 AND reserved_qty <= total_qty),
  available_qty INTEGER GENERATED ALWAYS AS (total_qty - reserved_qty) STORED,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_reservations (
  reservation_id UUID PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES inventory_items(item_id) ON DELETE RESTRICT,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  CHECK ((status = 'ACTIVE' AND released_at IS NULL) OR (status = 'RELEASED' AND released_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS stock_reservations_item_status_idx
  ON stock_reservations (item_id, status);
