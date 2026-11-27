import { ForbiddenException } from '@nestjs/common';
import { SuperAdminGuard } from './super-admin.guard.js';
import { USER_ROLE } from './user-role.js';

describe('SuperAdminGuard', () => {
  const auth = { authenticate: vi.fn() };
  const guard = new SuperAdminGuard(auth as never);
  const request = { headers: {} };
  const context = { switchToHttp: () => ({ getRequest: () => request }) } as never;

  it('allows active super administrators', async () => {
    auth.authenticate.mockResolvedValue({ id: 'admin-1', username: 'root', role: USER_ROLE.SUPER_ADMIN, active: true });
    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request).toHaveProperty('user', { id: 'admin-1', username: 'root', role: USER_ROLE.SUPER_ADMIN });
  });

  it('rejects regular roles and inactive users', async () => {
    auth.authenticate.mockResolvedValue({ id: 'user-1', username: 'staff', role: null, active: true });
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
    auth.authenticate.mockResolvedValue({ id: 'admin-1', username: 'root', role: USER_ROLE.SUPER_ADMIN, active: false });
    await expect(guard.canActivate(context)).rejects.toThrow(ForbiddenException);
  });
});
