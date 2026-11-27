ALTER TABLE auth_user_tenants
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'operator';

UPDATE auth_user_tenants AS membership
   SET role = users.role
  FROM auth_users AS users
 WHERE membership.user_id = users.id
   AND users.role IN ('tenant_admin', 'finance_manager', 'approver', 'operator');

ALTER TABLE auth_user_tenants
  DROP CONSTRAINT IF EXISTS auth_user_tenants_role_check;

ALTER TABLE auth_user_tenants
  ADD CONSTRAINT auth_user_tenants_role_check
  CHECK (role IN ('tenant_admin', 'finance_manager', 'approver', 'operator'));

UPDATE auth_users SET role = 'member' WHERE role <> 'super_admin';

ALTER TABLE auth_users
  DROP CONSTRAINT IF EXISTS auth_users_role_check;

ALTER TABLE auth_users
  ADD CONSTRAINT auth_users_role_check CHECK (role IN ('super_admin', 'member'));
