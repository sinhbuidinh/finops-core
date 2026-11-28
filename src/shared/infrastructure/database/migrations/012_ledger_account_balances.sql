CREATE TABLE IF NOT EXISTS ledger_account_balances (
  account_id TEXT NOT NULL REFERENCES ledger_accounts(account_id) ON DELETE RESTRICT,
  currency CHAR(3) NOT NULL,
  balance_minor_units NUMERIC(38, 0) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, currency)
);

-- Initialize the projection from the immutable journal before serving balance reads.
INSERT INTO ledger_account_balances (account_id, currency, balance_minor_units)
SELECT account.account_id,
       line.currency,
       SUM(CASE
         WHEN (account.type IN ('ASSET', 'EXPENSE') AND line.side = 'DEBIT')
           OR (account.type IN ('LIABILITY', 'EQUITY', 'REVENUE') AND line.side = 'CREDIT')
         THEN line.amount_minor_units ELSE -line.amount_minor_units END)::numeric(38, 0)
  FROM journal_entry_lines line
  JOIN ledger_accounts account ON account.account_id = line.account_id
 GROUP BY account.account_id, line.currency
ON CONFLICT (account_id, currency) DO UPDATE
  SET balance_minor_units = EXCLUDED.balance_minor_units,
      updated_at = now();