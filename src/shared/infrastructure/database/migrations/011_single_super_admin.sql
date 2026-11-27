ALTER TABLE auth_users ALTER COLUMN role DROP NOT NULL;

UPDATE auth_users SET role = NULL WHERE role = 'member';

ALTER TABLE auth_users
  DROP CONSTRAINT IF EXISTS auth_users_role_check;

ALTER TABLE auth_users
  ADD CONSTRAINT auth_users_role_check CHECK (role IS NULL OR role = 'super_admin');

DO $$
BEGIN
  IF (SELECT count(*) FROM auth_users WHERE role = 'super_admin') > 1 THEN
    RAISE EXCEPTION 'Multiple super_admin accounts exist; resolve them before applying migration 011';
  END IF;
END;
$$;

CREATE UNIQUE INDEX IF NOT EXISTS auth_users_single_super_admin_idx
  ON auth_users (role) WHERE role = 'super_admin';
