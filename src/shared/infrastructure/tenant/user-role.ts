export const USER_ROLE = {
  SUPER_ADMIN: 'super_admin',
  TENANT_ADMIN: 'tenant_admin',
  FINANCE_MANAGER: 'finance_manager',
  APPROVER: 'approver',
  OPERATOR: 'operator',
} as const;

export type UserRole = typeof USER_ROLE[keyof typeof USER_ROLE];
export type TenantRole = Exclude<UserRole, typeof USER_ROLE.SUPER_ADMIN>;

export const TENANT_ROLES: readonly TenantRole[] = [
  USER_ROLE.TENANT_ADMIN,
  USER_ROLE.FINANCE_MANAGER,
  USER_ROLE.APPROVER,
  USER_ROLE.OPERATOR,
];

export function isTenantRole(role: unknown): role is TenantRole {
  return typeof role === 'string' && TENANT_ROLES.includes(role as TenantRole);
}
