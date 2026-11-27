CREATE TABLE IF NOT EXISTS auth_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role ~ '^[a-z][a-z0-9_:-]{1,63}$'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_user_tenants (
  user_id UUID NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS auth_user_tenants_tenant_idx ON auth_user_tenants (tenant_id);
