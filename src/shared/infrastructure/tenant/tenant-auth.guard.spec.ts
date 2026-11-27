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

    const validToken = token({ sub: 'user-1', tenant_id: 'tenant-1' });
    const invalid = makeRequest(`${validToken.slice(0, validToken.lastIndexOf('.') + 1)}${Buffer.alloc(32).toString('base64url')}`);
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

  it('rejects empty tenant selectors, malformed JWT headers, and missing memberships', () => {
    const emptySelector = makeRequest(token({ sub: 'user-1', tenant_id: 'tenant-1' }));
    emptySelector.headers['x-tenant-id'] = '   ';
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(emptySelector)))).toThrow(UnauthorizedException);

    const unsupportedAlgorithm = makeRequest(token({ sub: 'user-1', tenant_id: 'tenant-1' }, { alg: 'none' }));
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(unsupportedAlgorithm)))).toThrow(UnauthorizedException);

    const noMembership = makeRequest(token({ sub: 'user-1', tenant_ids: [] }));
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(noMembership)))).toThrow(UnauthorizedException);

    const malformedJson = makeRequest(malformedToken());
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(malformedJson)))).toThrow(UnauthorizedException);
  });

  it('requires a sufficiently long signing secret', () => {
    vi.stubEnv('AUTH_JWT_SECRET', 'too-short');
    const request = makeRequest(token({ sub: 'user-1', tenant_id: 'tenant-1' }));
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(request))))
      .toThrow('AUTH_JWT_SECRET must be configured with at least 32 bytes');
  });

  it('enforces configured issuer and audience claims', () => {
    vi.stubEnv('AUTH_JWT_ISSUER', 'https://issuer.example');
    vi.stubEnv('AUTH_JWT_AUDIENCE', 'finops-api');

    const valid = makeRequest(token({
      sub: 'user-1', tenant_id: 'tenant-1', iss: 'https://issuer.example', aud: ['finops-api'],
    }));
    expect(context.run(() => guard.canActivate(makeExecutionContext(valid)))).toBe(true);

    const wrongIssuer = makeRequest(token({ sub: 'user-1', tenant_id: 'tenant-1', iss: 'https://wrong.example', aud: 'finops-api' }));
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(wrongIssuer)))).toThrow(UnauthorizedException);

    const wrongAudience = makeRequest(token({ sub: 'user-1', tenant_id: 'tenant-1', iss: 'https://issuer.example', aud: 'other-api' }));
    expect(() => context.run(() => guard.canActivate(makeExecutionContext(wrongAudience)))).toThrow(UnauthorizedException);
  });

  function token(claims: Record<string, unknown>, headerClaims: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' }): string {
    const header = Buffer.from(JSON.stringify(headerClaims)).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 300, ...claims })).toString('base64url');
    const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  function malformedToken(): string {
    const header = Buffer.from('{').toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-1', tenant_id: 'tenant-1', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url');
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
