import { createHmac } from 'node:crypto';
import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AuthUserRepository } from './auth-user.repository.js';
import { verifyPassword } from './password-hasher.js';
import { USER_ROLE } from './user-role.js';

@Injectable()
export class LoginService {
  constructor(private readonly users: AuthUserRepository) {}

  async login(username: string, password: string): Promise<{ accessToken: string; tokenType: 'Bearer'; expiresIn: number }> {
    const secret = process.env.AUTH_JWT_SECRET;
    const expiresIn = Number(process.env.AUTH_JWT_EXPIRES_IN);
    if (!secret || Buffer.byteLength(secret) < 32) {
      throw new ServiceUnavailableException('Login secret is not configured');
    }
    if (!Number.isSafeInteger(expiresIn) || expiresIn <= 0) {
      throw new ServiceUnavailableException('Login expiration is not configured');
    }
    const user = await this.users.findByUsername(username);
    const valid = await verifyPassword(password, user?.passwordHash);
    if (!user || !user.active || !valid) throw new UnauthorizedException('Invalid username or password');

    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { sub: user.id, iat: now, exp: now + expiresIn };
    if (user.role === USER_ROLE.SUPER_ADMIN) claims.role = USER_ROLE.SUPER_ADMIN;
    else {
      claims.tenant_ids = user.tenantRoles.map((assignment) => assignment.tenantId);
      claims.tenant_roles = user.tenantRoles;
    }
    if (process.env.AUTH_JWT_ISSUER) claims.iss = process.env.AUTH_JWT_ISSUER;
    if (process.env.AUTH_JWT_AUDIENCE) claims.aud = process.env.AUTH_JWT_AUDIENCE;
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode(claims);
    const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
    return { accessToken: `${header}.${payload}.${signature}`, tokenType: 'Bearer', expiresIn };
  }
}

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
