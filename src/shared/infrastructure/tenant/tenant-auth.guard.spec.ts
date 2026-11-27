import { createHmac } from 'node:crypto';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { TenantAuthGuard } from './tenant-auth.guard.js';
import { TenantContext } from './tenant-context.js';

describe('TenantAuthGuard', () => {
  const secret = 'unit-test-secret-with-more-than-32-bytes';
  let context: TenantContext;
  let guard: TenantAuthGuard;

  beforeEach(() => {
    vi.stubEnv('AUTH_JWT_SECRET', secret);
    vi.stubEnv('AUTH_JWT_ISSUER', '');
    vi.stubEnv('AUTH_JWT_AUDIENCE', '');
    context = new TenantContext();
    guard = new TenantAuthGuard(context);
  });

  afterEach(() => vi.unstubAllEnvs());

  it('resolves the single tenant from a signed token into request context', () => {
    const request = makeRequest(token({ sub: 'user-1', tenant_id: 'tenant-1' }));
    const tenantId = context.run(() => {
      expect(guard.canActivate(makeExecutionContext(request))).toBe(true);
      return context.requireTenantId();
    });
    expect(tenantId).toBe('tenant-1');
    expect(request.tenantId).toBe('tenant-1');
  });

  it('allows selecting only a tenant in the token membership list', () => {
    const request = makeRequest(token({ sub: 'user-1', tenant_ids: ['tenant-1', 'tenant-2'] }), 'tenant-2');
    expect(context.run(() => {
      guard.canActivate(makeExecutionContext(request));
      return context.requireTenantId();
    })).toBe('tenant-2');
  });

  it('rejects missing credentials, invalid signatures, expired tokens and unauthorized tenant selection', () => {
    const missing = makeRequest(undefined);
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(missing)))).toThrow(UnauthorizedException);

    const invalid = makeRequest(`${token({ sub: 'user-1', tenant_id: 'tenant-1' }).slice(0, -1)}x`);
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(invalid)))).toThrow(UnauthorizedException);

    const expired = makeRequest(token({ sub: 'user-1', tenant_id: 'tenant-1', exp: 1 }));
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(expired)))).toThrow(UnauthorizedException);

    const forbidden = makeRequest(token({ sub: 'user-1', tenant_id: 'tenant-1' }), 'tenant-2');
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(forbidden)))).toThrow(ForbiddenException);
  });

  it('requires a tenant selector when the user belongs to multiple tenants', () => {
    const request = makeRequest(token({ sub: 'user-1', tenant_ids: ['tenant-1', 'tenant-2'] }));
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(request)))).toThrow(UnauthorizedException);
  });

  function token(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...claims })).toString('base64url');
    const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  function makeRequest(token: string | undefined, tenantId?: string) {
    return {
      headers: {
        authorization: token ? `Bearer ${token}` : undefined,
        ...(tenantId ? { 'x-tenant-id': tenantId } : {}),
      },
    } as { headers: Record<string, string | undefined>; tenantId?: string };
  }

  function makeExecutionContext(request: unknown) {
    return { switchToHttp: () => ({ getRequest: () => request }) } as never;
  }
});
