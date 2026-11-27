import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TenantAdminGuard } from './tenant-admin.guard.js';
import { USER_ROLE } from './user-role.js';

describe('TenantAdminGuard', () => {
  const auth = { authenticate: vi.fn() };
  const guard = new TenantAdminGuard(auth as never);
  const request: { headers: Record<string, string>; params: { tenantId: string }; tenantId?: string; user?: unknown } = {
    headers: {}, params: { tenantId: 'tenant-a' },
  };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;

  it('allows a tenant administrator only for a tenant they administer', async () => {
    auth.authenticate.mockResolvedValue({
      id: 'admin-1', username: 'tenant-admin', role: null, active: true,
      tenantRoles: [{ tenantId: 'tenant-a', role: USER_ROLE.TENANT_ADMIN }, { tenantId: 'tenant-b', role: USER_ROLE.FINANCE_MANAGER }],
    });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.tenantId).toBe('tenant-a');
    expect(request.user).toEqual({ id: 'admin-1', username: 'tenant-admin', role: USER_ROLE.TENANT_ADMIN });
    request.params.tenantId = 'tenant-b';
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });

  it('allows global super admins and rejects other roles or missing tenant IDs', async () => {
    auth.authenticate.mockResolvedValue({ id: 'root', username: 'root', role: USER_ROLE.SUPER_ADMIN, active: true, tenantRoles: [] });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    auth.authenticate.mockResolvedValue({
      id: 'staff', username: 'staff', role: null, active: true,
      tenantRoles: [{ tenantId: 'tenant-a', role: USER_ROLE.OPERATOR }],
    });
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    request.params.tenantId = '';
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });
});
