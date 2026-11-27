import { createHmac } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { TenantContext } from './tenant-context.js';
import { USER_ROLE } from './user-role.js';

describe('TenantAuthGuard', () => {
  const secret = 'unit-test-secret-with-more-than-32-bytes';
  const records = new Map<string, { id: string; username: string; role: string | null; tenantRoles: { tenantId: string; role: string }[]; active: boolean; passwordHash: string }>();
  let context: TenantContext;
  let guard: TenantAuthGuard;

  beforeEach(() => {
    vi.stubEnv('AUTH_JWT_SECRET', secret);
    vi.stubEnv('AUTH_JWT_ISSUER', '');
    vi.stubEnv('AUTH_JWT_AUDIENCE', '');
    records.clear();
    records.set('user-1', { id: 'user-1', username: 'user', role: null,
      tenantRoles: [{ tenantId: 'tenant-1', role: USER_ROLE.FINANCE_MANAGER }, { tenantId: 'tenant-2', role: USER_ROLE.APPROVER }], active: true, passwordHash: '' });
    records.set('admin-1', { id: 'admin-1', username: 'root', role: USER_ROLE.SUPER_ADMIN, tenantRoles: [], active: true, passwordHash: '' });
    context = new TenantContext();
    guard = new TenantAuthGuard(context, { findById: async (id: string) => records.get(id) } as never);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('resolves an assigned tenant into request and async context', async () => {
    const request = makeRequest(token({ sub: 'user-1' }), 'tenant-2');
    const tenantId = await context.run(async () => {
      expect(await guard.canActivate(makeExecutionContext(request))).toBe(true);
      return context.requireTenantId();
    });
    expect(tenantId).toBe('tenant-2');
    expect(request.tenantId).toBe('tenant-2');
    expect(request.user?.role).toBe(USER_ROLE.APPROVER);
  });

  it('rejects unassigned tenant selection and requires a selector for multiple assignments', async () => {
    const forbidden = makeRequest(token({ sub: 'user-1' }), 'tenant-3');
    await expect(context.run(() => guard.canActivate(makeExecutionContext(forbidden)))).rejects.toThrow(ForbiddenException);
    const missingSelector = makeRequest(token({ sub: 'user-1' }));
    await expect(context.run(() => guard.canActivate(makeExecutionContext(missingSelector)))).rejects.toThrow(UnauthorizedException);
  });

  it('allows super admins to select any tenant and requires an explicit selector', async () => {
    const request = makeRequest(token({ sub: 'admin-1' }), 'arbitrary-tenant');
    await context.run(() => guard.canActivate(makeExecutionContext(request)));
    expect(request.tenantId).toBe('arbitrary-tenant');
    await expect(context.run(() => guard.canActivate(makeExecutionContext(makeRequest(token({ sub: 'admin-1' }))))))
      .rejects.toThrow(UnauthorizedException);
  });

  it('rejects invalid signatures, expired tokens, deleted users, and deactivated users', async () => {
    const valid = token({ sub: 'user-1' });
    const invalid = `${valid.slice(0, valid.lastIndexOf('.') + 1)}${Buffer.alloc(32).toString('base64url')}`;
    await expect(guard.canActivate(makeExecutionContext(makeRequest(invalid)))).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(makeExecutionContext(makeRequest(token({ sub: 'user-1', exp: 1 }))))).rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(makeExecutionContext(makeRequest(token({ sub: 'deleted' }))))).rejects.toThrow(UnauthorizedException);
    records.get('user-1')!.active = false;
    await expect(guard.canActivate(makeExecutionContext(makeRequest(token({ sub: 'user-1' })))))
      .rejects.toThrow(UnauthorizedException);
  });

  it('rejects missing, malformed, unsupported, and not-yet-valid bearer tokens', async () => {
    await expect(guard.authenticate(makeRequest(undefined) as never)).rejects.toThrow(UnauthorizedException);
    await expect(guard.authenticate(makeRequest('Bearer a.b') as never)).rejects.toThrow(UnauthorizedException);
    const malformed = `${Buffer.from('{').toString('base64url')}.e30.${Buffer.alloc(32).toString('base64url')}`;
    await expect(guard.authenticate(makeRequest(malformed) as never)).rejects.toThrow(UnauthorizedException);
    const unsupported = token({ sub: 'user-1' }).split('.');
    unsupported[0] = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
    await expect(guard.authenticate(makeRequest(unsupported.join('.')) as never)).rejects.toThrow(UnauthorizedException);
    await expect(guard.authenticate(makeRequest(token({ sub: 'user-1', nbf: Math.floor(Date.now() / 1000) + 60 })) as never))
      .rejects.toThrow(UnauthorizedException);
  });

  it('rejects missing or weak JWT secrets and empty tenant selectors', async () => {
    vi.stubEnv('AUTH_JWT_SECRET', 'short');
    await expect(guard.authenticate(makeRequest(token({ sub: 'user-1' })) as never)).rejects.toThrow('at least 32 bytes');
    vi.stubEnv('AUTH_JWT_SECRET', secret);
    const emptyTenant = makeRequest(token({ sub: 'user-1' }));
    emptyTenant.headers['x-tenant-id'] = '  ';
    await expect(guard.canActivate(makeExecutionContext(emptyTenant))).rejects.toThrow('must not be empty');
  });

  it('selects the only tenant automatically and rejects tokens with invalid subject claims', async () => {
    const single = records.get('user-1')!;
    single.tenantRoles = [{ tenantId: 'tenant-only', role: USER_ROLE.OPERATOR }];
    const request = makeRequest(token({ sub: 'user-1' }));
    await context.run(() => guard.canActivate(makeExecutionContext(request)));
    expect(request.tenantId).toBe('tenant-only');
    await expect(guard.authenticate(makeRequest(token({ sub: 5 })) as never)).rejects.toThrow(UnauthorizedException);
  });

  it('enforces configured issuer and audience', async () => {
    vi.stubEnv('AUTH_JWT_ISSUER', 'https://issuer.test');
    vi.stubEnv('AUTH_JWT_AUDIENCE', 'finops-api');
    await expect(guard.canActivate(makeExecutionContext(makeRequest(token({ sub: 'user-1', iss: 'https://bad.test', aud: 'finops-api' })))))
      .rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(makeExecutionContext(makeRequest(token({ sub: 'user-1', iss: 'https://issuer.test', aud: 'wrong' })))))
      .rejects.toThrow(UnauthorizedException);
    expect(await guard.authenticate(makeRequest(token({ sub: 'user-1', iss: 'https://issuer.test', aud: ['finops-api'] })) as never)).toMatchObject({ id: 'user-1' });
  });

  function token(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...claims })).toString('base64url');
    const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  function makeRequest(jwt: string | undefined, tenantId?: string) {
    return { headers: { authorization: jwt ? `Bearer ${jwt}` : undefined, ...(tenantId ? { 'x-tenant-id': tenantId } : {}) } } as {
      headers: Record<string, string | undefined>; tenantId?: string; user?: { role: string };
    };
  }

  function makeExecutionContext(request: unknown) {
    return { switchToHttp: () => ({ getRequest: () => request }) } as never;
  }
});
