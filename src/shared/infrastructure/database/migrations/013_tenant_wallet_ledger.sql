ALTER TABLE ledger_accounts ADD COLUMN IF NOT EXISTS tenant_id TEXT;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS tenant_id TEXT;

CREATE INDEX IF NOT EXISTS journal_entries_tenant_posted_idx
  ON journal_entries (tenant_id, posted_at DESC, entry_id DESC);

CREATE TABLE IF NOT EXISTS wallets (
  wallet_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(trim(tenant_id)) > 0),
  ledger_account_id TEXT NOT NULL UNIQUE REFERENCES ledger_accounts(account_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (wallet_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS wallets_tenant_idx ON wallets (tenant_id, wallet_id);

CREATE OR REPLACE FUNCTION ensure_wallet_account_tenant() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM ledger_accounts account
     WHERE account.account_id = NEW.ledger_account_id AND account.tenant_id = NEW.tenant_id
  ) THEN
    RAISE EXCEPTION 'wallet account must belong to the same tenant'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS wallet_account_tenant_check ON wallets;
CREATE TRIGGER wallet_account_tenant_check BEFORE INSERT OR UPDATE ON wallets
  FOR EACH ROW EXECUTE FUNCTION ensure_wallet_account_tenant();

INSERT INTO ledger_accounts (account_id, name, type, tenant_id)
VALUES ('platform:order-clearing', 'Platform order clearing', 'ASSET', NULL)
ON CONFLICT (account_id) DO NOTHING;
