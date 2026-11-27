-- Existing inventory predates tenant scoping. Preserve its rows under tenant-1,
-- the default tenant used by the initial sample flow, then require tenant IDs.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE inventory_items SET tenant_id = 'tenant-1' WHERE tenant_id IS NULL;
ALTER TABLE inventory_items ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS tenant_id TEXT;
UPDATE stock_reservations r SET tenant_id = i.tenant_id
  FROM inventory_items i WHERE r.item_id = i.item_id AND r.tenant_id IS NULL;
UPDATE stock_reservations SET tenant_id = 'tenant-1' WHERE tenant_id IS NULL;
ALTER TABLE stock_reservations ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE stock_reservations DROP CONSTRAINT IF EXISTS stock_reservations_item_id_fkey;
ALTER TABLE stock_reservations DROP CONSTRAINT IF EXISTS stock_reservations_tenant_item_fkey;
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_pkey;
ALTER TABLE inventory_items ADD CONSTRAINT inventory_items_pkey PRIMARY KEY (tenant_id, item_id);
ALTER TABLE stock_reservations ADD CONSTRAINT stock_reservations_tenant_item_fkey
  FOREIGN KEY (tenant_id, item_id) REFERENCES inventory_items(tenant_id, item_id) ON DELETE RESTRICT;

DROP INDEX IF EXISTS stock_reservations_item_status_idx;
CREATE INDEX IF NOT EXISTS stock_reservations_item_status_idx ON stock_reservations (tenant_id, item_id, status);

DROP INDEX IF EXISTS stock_reservations_idempotency_key_idx;
CREATE UNIQUE INDEX IF NOT EXISTS stock_reservations_idempotency_key_idx
  ON stock_reservations (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
