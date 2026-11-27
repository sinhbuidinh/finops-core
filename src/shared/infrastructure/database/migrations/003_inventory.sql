CREATE TABLE IF NOT EXISTS inventory_items (
  tenant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  total_qty INTEGER NOT NULL CHECK (total_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0 AND reserved_qty <= total_qty),
  available_qty INTEGER GENERATED ALWAYS AS (total_qty - reserved_qty) STORED,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id)
);

CREATE TABLE IF NOT EXISTS stock_reservations (
  reservation_id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RELEASED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  CHECK ((status = 'ACTIVE' AND released_at IS NULL) OR (status = 'RELEASED' AND released_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, item_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS stock_reservations_item_status_idx
  ON stock_reservations (item_id, status);
