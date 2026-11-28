import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { LoginService } from './login.service.js';
import { hashPassword } from './password-hasher.js';
import { USER_ROLE } from './user-role.js';

describe('LoginService', () => {
  const originalEnv = { ...process.env };
  const users = { findByUsername: vi.fn() };
  const service = new LoginService(users as never);

  beforeEach(async () => {
    users.findByUsername.mockClear();
    vi.stubEnv('AUTH_JWT_SECRET', 'test-secret-that-is-longer-than-thirty-two-bytes');
    vi.stubEnv('AUTH_JWT_EXPIRES_IN', '3600');
    vi.stubEnv('AUTH_JWT_ISSUER', 'https://issuer.test');
    vi.stubEnv('AUTH_JWT_AUDIENCE', 'finops-api');
    users.findByUsername.mockResolvedValue({
      id: 'user-1', username: 'operator@example.com', passwordHash: await hashPassword('correct horse battery staple'),
      role: null,
      tenantRoles: [{ tenantId: 'tenant-a', role: USER_ROLE.FINANCE_MANAGER }, { tenantId: 'tenant-b', role: USER_ROLE.APPROVER }], active: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
  });

  it('issues a signed JWT containing assigned tenants and their roles', async () => {
    const result = await service.login('operator@example.com', 'correct horse battery staple');
    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(3600);
    const [header, payload, signature] = result.accessToken.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims.sub).toBe('user-1');
    expect(claims.tenant_ids).toEqual(['tenant-a', 'tenant-b']);
    expect(claims.tenant_roles).toEqual([{ tenantId: 'tenant-a', role: USER_ROLE.FINANCE_MANAGER }, { tenantId: 'tenant-b', role: USER_ROLE.APPROVER }]);
    expect(claims.iss).toBe('https://issuer.test');
    expect(claims.aud).toBe('finops-api');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(signature).toBe(createHmac('sha256', process.env.AUTH_JWT_SECRET!).update(`${header}.${payload}`).digest('base64url'));
  });

  it('does not put tenant restrictions in a super administrator token', async () => {
    users.findByUsername.mockResolvedValueOnce({
      id: 'admin-1', username: 'root', passwordHash: await hashPassword('correct horse battery staple'),
      role: USER_ROLE.SUPER_ADMIN, tenantRoles: [], active: true,
    });
    const { accessToken } = await service.login('root', 'correct horse battery staple');
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString());
    expect(claims.role).toBe(USER_ROLE.SUPER_ADMIN);
    expect(claims.tenant_ids).toBeUndefined();
  });

  it('uses AUTH_JWT_EXPIRES_IN in the response and token expiration claim', async () => {
    vi.stubEnv('AUTH_JWT_EXPIRES_IN', '900');
    const result = await service.login('operator@example.com', 'correct horse battery staple');
    const claims = JSON.parse(Buffer.from(result.accessToken.split('.')[1]!, 'base64url').toString());
    expect(result.expiresIn).toBe(900);
    expect(claims.exp - claims.iat).toBe(900);
  });

  it('omits optional issuer and audience claims when they are not configured', async () => {
    delete process.env.AUTH_JWT_ISSUER;
    delete process.env.AUTH_JWT_AUDIENCE;
    const { accessToken } = await service.login('operator@example.com', 'correct horse battery staple');
    const claims = JSON.parse(Buffer.from(accessToken.split('.')[1]!, 'base64url').toString());
    expect(claims).not.toHaveProperty('iss');
    expect(claims).not.toHaveProperty('aud');
  });

  it('fails closed with a specific error when the JWT secret is missing or too short', async () => {
    vi.stubEnv('AUTH_JWT_SECRET', 'short');
    await expect(service.login('operator@example.com', 'correct horse battery staple'))
      .rejects.toThrow(new ServiceUnavailableException('Login secret is not configured'));
    vi.stubEnv('AUTH_JWT_SECRET', '');
    await expect(service.login('operator@example.com', 'correct horse battery staple'))
      .rejects.toThrow('Login secret is not configured');
    expect(users.findByUsername).not.toHaveBeenCalled();
  });

  it('fails closed with a specific error when AUTH_JWT_EXPIRES_IN is missing or invalid', async () => {
    vi.stubEnv('AUTH_JWT_EXPIRES_IN', '');
    await expect(service.login('operator@example.com', 'correct horse battery staple'))
      .rejects.toThrow('Login expiration is not configured');
    vi.stubEnv('AUTH_JWT_EXPIRES_IN', '0');
    await expect(service.login('operator@example.com', 'correct horse battery staple'))
      .rejects.toThrow('Login expiration is not configured');
    vi.stubEnv('AUTH_JWT_EXPIRES_IN', 'not-a-number');
    await expect(service.login('operator@example.com', 'correct horse battery staple'))
      .rejects.toThrow('Login expiration is not configured');
    expect(users.findByUsername).not.toHaveBeenCalled();
  });

  it('rejects unknown, inactive, and wrong-password accounts', async () => {
    users.findByUsername.mockResolvedValueOnce(undefined);
    await expect(service.login('missing', 'wrong')).rejects.toThrow(UnauthorizedException);
    users.findByUsername.mockResolvedValueOnce({
      id: 'user-1', username: 'disabled', passwordHash: await hashPassword('correct horse battery staple'),
      role: null, tenantRoles: [{ tenantId: 'tenant-a', role: USER_ROLE.OPERATOR }], active: false,
    });
    await expect(service.login('disabled', 'correct horse battery staple')).rejects.toThrow(UnauthorizedException);
    await expect(service.login('operator@example.com', 'wrong')).rejects.toThrow(UnauthorizedException);
  });
});
