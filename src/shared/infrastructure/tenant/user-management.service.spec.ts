import { UnprocessableEntityException, UnauthorizedException } from '@nestjs/common';
import { UserManagementService } from './user-management.service.js';
import { USER_ROLE } from './user-role.js';

describe('UserManagementService', () => {
  const originalToken = process.env.AUTH_BOOTSTRAP_TOKEN;
  const users = { create: vi.fn(), bootstrap: vi.fn(), listByTenant: vi.fn(), updateTenantRole: vi.fn() };
  const service = new UserManagementService(users as never);

  beforeEach(() => {
    users.create.mockResolvedValue({ id: 'user-1', username: 'employee@example.com', role: null, tenantRoles: [
      { tenantId: 'tenant-a', role: USER_ROLE.FINANCE_MANAGER }, { tenantId: 'tenant-b', role: USER_ROLE.APPROVER },
    ] });
    users.bootstrap.mockResolvedValue({ id: 'admin-1', username: 'root', role: USER_ROLE.SUPER_ADMIN, tenantRoles: [] });
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.AUTH_BOOTSTRAP_TOKEN;
    else process.env.AUTH_BOOTSTRAP_TOKEN = originalToken;
  });

  it('creates a user with different roles per tenant and never returns a password hash', async () => {
    const created = await service.createUser({
      username: 'employee@example.com', password: 'long-enough-password', tenants: [
        { tenantId: 'tenant-a', role: USER_ROLE.FINANCE_MANAGER }, { tenantId: 'tenant-b', role: USER_ROLE.APPROVER },
      ],
    });
    expect(users.create).toHaveBeenCalledWith(expect.objectContaining({
      username: 'employee@example.com', role: null,
      tenantRoles: [{ tenantId: 'tenant-a', role: USER_ROLE.FINANCE_MANAGER }, { tenantId: 'tenant-b', role: USER_ROLE.APPROVER }],
    }));
    expect(created).toEqual({ id: 'user-1', username: 'employee@example.com', tenantRoles: [
      { tenantId: 'tenant-a', role: USER_ROLE.FINANCE_MANAGER }, { tenantId: 'tenant-b', role: USER_ROLE.APPROVER },
    ] });
    expect(created).not.toHaveProperty('passwordHash');
  });

  it('requires valid tenant role assignments and a long password', async () => {
    await expect(service.createUser({ username: 'staff', password: 'too-short', tenants: [{ tenantId: 'tenant-a', role: USER_ROLE.OPERATOR }] }))
      .rejects.toThrow(UnprocessableEntityException);
    await expect(service.createUser({ username: 'staff', password: 'long-enough-password', tenants: [] }))
      .rejects.toThrow(UnprocessableEntityException);
    await expect(service.createUser({ username: 'staff', password: 'long-enough-password', tenants: [{ tenantId: 'tenant-a', role: 'arbitrary' }] }))
      .rejects.toThrow(UnprocessableEntityException);
  });

  it('lists users with only their role in the selected tenant and updates that tenant role', async () => {
    users.listByTenant.mockResolvedValue([{ id: 'user-1', username: 'employee', tenantRoles: [
      { tenantId: 'tenant-a', role: USER_ROLE.TENANT_ADMIN }, { tenantId: 'tenant-b', role: USER_ROLE.APPROVER },
    ] }]);
    await expect(service.listTenantUsers('tenant-a')).resolves.toEqual([
      { id: 'user-1', username: 'employee', role: USER_ROLE.TENANT_ADMIN },
    ]);
    users.updateTenantRole.mockResolvedValue({ id: 'user-1', username: 'employee' });
    await expect(service.updateTenantUserRole('user-1', 'tenant-a', USER_ROLE.OPERATOR)).resolves.toEqual({
      id: 'user-1', username: 'employee', role: USER_ROLE.OPERATOR,
    });
    expect(users.updateTenantRole).toHaveBeenCalledWith('user-1', 'tenant-a', USER_ROLE.OPERATOR);
  });

  it('creates the initial super administrator only with the configured bootstrap token', async () => {
    process.env.AUTH_BOOTSTRAP_TOKEN = 'one-time-setup-secret';
    await expect(service.bootstrap({ username: 'root', password: 'long-enough-password', bootstrapToken: 'wrong' }))
      .rejects.toThrow(UnauthorizedException);
    await expect(service.bootstrap({ username: 'root', password: 'short', bootstrapToken: 'one-time-setup-secret' }))
      .rejects.toThrow(UnprocessableEntityException);
    await expect(service.bootstrap({ username: 'root', password: 'long-enough-password', bootstrapToken: 'one-time-setup-secret' }))
      .resolves.toEqual({ id: 'admin-1', username: 'root', role: USER_ROLE.SUPER_ADMIN, tenantRoles: [] });
  });
});
