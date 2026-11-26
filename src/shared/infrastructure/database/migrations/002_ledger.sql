CREATE TABLE IF NOT EXISTS ledger_accounts (
  account_id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  type TEXT NOT NULL CHECK (type IN ('ASSET', 'LIABILITY', 'EQUITY', 'REVENUE', 'EXPENSE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS journal_entries (
  entry_id TEXT PRIMARY KEY,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  posted_at TIMESTAMPTZ NOT NULL,
  reversal_of_entry_id TEXT UNIQUE REFERENCES journal_entries(entry_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (reversal_of_entry_id IS NULL OR reversal_of_entry_id <> entry_id)
);

CREATE INDEX IF NOT EXISTS journal_entries_posted_idx
  ON journal_entries (posted_at DESC, entry_id DESC);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  entry_id TEXT NOT NULL REFERENCES journal_entries(entry_id) ON DELETE RESTRICT,
  line_number INTEGER NOT NULL CHECK (line_number > 0),
  account_id TEXT NOT NULL REFERENCES ledger_accounts(account_id) ON DELETE RESTRICT,
  side TEXT NOT NULL CHECK (side IN ('DEBIT', 'CREDIT')),
  amount_minor_units BIGINT NOT NULL CHECK (amount_minor_units > 0),
  currency CHAR(3) NOT NULL,
  memo TEXT,
  PRIMARY KEY (entry_id, line_number)
);

CREATE INDEX IF NOT EXISTS journal_entry_lines_account_idx
  ON journal_entry_lines (account_id, currency, entry_id);

CREATE OR REPLACE FUNCTION ensure_journal_entry_balanced() RETURNS trigger AS $$
DECLARE
  entry_key TEXT;
  debit_total NUMERIC;
  credit_total NUMERIC;
  line_count INTEGER;
  currency_count INTEGER;
BEGIN
  entry_key := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COUNT(*),
         COALESCE(SUM(amount_minor_units) FILTER (WHERE side = 'DEBIT'), 0),
         COALESCE(SUM(amount_minor_units) FILTER (WHERE side = 'CREDIT'), 0)
         , COUNT(DISTINCT currency)
    INTO line_count, debit_total, credit_total, currency_count
    FROM journal_entry_lines WHERE entry_id = entry_key;
  IF line_count < 2 OR debit_total <> credit_total THEN
    RAISE EXCEPTION 'journal entry % must have at least two balanced lines', entry_key
      USING ERRCODE = '23514';
  END IF;
  IF currency_count > 1 THEN
    RAISE EXCEPTION 'journal entry % must use one currency', entry_key USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entry_balance_check ON journal_entries;
CREATE CONSTRAINT TRIGGER journal_entry_balance_check
  AFTER INSERT ON journal_entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_journal_entry_balanced();
DROP TRIGGER IF EXISTS journal_entry_lines_balance_check ON journal_entry_lines;
CREATE CONSTRAINT TRIGGER journal_entry_lines_balance_check
  AFTER INSERT ON journal_entry_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ensure_journal_entry_balanced();

CREATE OR REPLACE FUNCTION reject_ledger_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'posted ledger records are append-only' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_entries_append_only ON journal_entries;
CREATE TRIGGER journal_entries_append_only BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
DROP TRIGGER IF EXISTS journal_entry_lines_append_only ON journal_entry_lines;
CREATE TRIGGER journal_entry_lines_append_only BEFORE UPDATE OR DELETE ON journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION reject_ledger_mutation();
