CREATE TABLE IF NOT EXISTS fulfillment_saga_jobs (
  saga_id UUID PRIMARY KEY,
  order_id TEXT NOT NULL,
  payload JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS fulfillment_saga_jobs_ready_idx
  ON fulfillment_saga_jobs (available_at, created_at) WHERE state = 'PENDING';
