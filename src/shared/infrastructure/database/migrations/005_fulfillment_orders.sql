CREATE TABLE IF NOT EXISTS fulfillment_orders (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('APPROVED', 'RESERVING_STOCK', 'SETTLING_PAYMENT', 'CONFIRMED', 'CANCELLED', 'FAILED')),
  saga_id UUID NOT NULL UNIQUE REFERENCES fulfillment_saga_jobs(saga_id) DEFERRABLE INITIALLY DEFERRED,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fulfillment_orders_tenant_created_idx ON fulfillment_orders (tenant_id, created_at DESC);
