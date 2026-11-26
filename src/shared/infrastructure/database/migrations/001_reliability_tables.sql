CREATE TABLE IF NOT EXISTS idempotency_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('IN_PROGRESS', 'COMPLETED')),
  owner_token UUID,
  response_status INTEGER,
  response_body JSONB,
  lease_expires_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key),
  CHECK (
    (state = 'IN_PROGRESS' AND owner_token IS NOT NULL AND lease_expires_at IS NOT NULL
      AND response_status IS NULL)
    OR
    (state = 'COMPLETED' AND owner_token IS NULL AND lease_expires_at IS NULL
      AND response_status IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idempotency_keys_expiry_idx
  ON idempotency_keys (expires_at);

CREATE TABLE IF NOT EXISTS outbox_events (
  event_id UUID PRIMARY KEY,
  aggregate_id TEXT NOT NULL,
  event_name TEXT NOT NULL,
  payload JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (state IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'DEAD_LETTER')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by UUID,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  CHECK (
    (state = 'PROCESSING' AND locked_at IS NOT NULL AND locked_by IS NOT NULL)
    OR
    (state <> 'PROCESSING' AND locked_at IS NULL AND locked_by IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
  ON outbox_events (available_at, created_at)
  WHERE state IN ('PENDING', 'PROCESSING');
