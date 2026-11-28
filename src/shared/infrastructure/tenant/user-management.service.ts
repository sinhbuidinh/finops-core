import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { AuthUserRepository, type TenantAssignment } from './auth-user.repository.js';
import { hashPassword } from './password-hasher.js';
import { isTenantRole, TENANT_ROLES, USER_ROLE } from './user-role.js';

@Injectable()
export class UserManagementService {
  constructor(private readonly users: AuthUserRepository) {}

  async createUser(input: { username: string; password: string; tenants: TenantAssignment[] }) {
    validateUserInput(input);
    const user = await this.users.create({
      username: input.username,
      passwordHash: await hashPassword(input.password),
      role: null,
      tenantRoles: input.tenants,
    });
    return publicUser(user);
  }

  async listTenantUsers(tenantId: string) {
    return (await this.users.listByTenant(tenantId)).map((user) => ({
      id: user.id,
      username: user.username,
      role: user.tenantRoles.find((membership) => membership.tenantId === tenantId)!.role,
    }));
  }

  async updateTenantUserRole(userId: string, tenantId: string, role: string) {
    if (!isTenantRole(role)) throw new UnprocessableEntityException(`Role must be one of: ${TENANT_ROLES.join(', ')}`);
    const user = await this.users.updateTenantRole(userId, tenantId, role);
    return { id: user.id, username: user.username, role };
  }

  async bootstrap(input: { username: string; password: string; bootstrapToken: string }) {
    const configuredToken = process.env.AUTH_BOOTSTRAP_TOKEN;
    if (!configuredToken || !safeEqual(input.bootstrapToken, configuredToken)) {
      throw new UnauthorizedException('Invalid bootstrap token');
    }
    if (!input.username.trim() || input.password.length < 12) {
      throw new UnprocessableEntityException('Username is required and password must contain at least 12 characters');
    }
    const user = await this.users.bootstrap({ username: input.username, passwordHash: await hashPassword(input.password) });
    return publicUser(user);
  }
}

function validateUserInput(input: { username: string; password: string; tenants: TenantAssignment[] }): void {
  if (!input.username.trim() || input.password.length < 12 || !Array.isArray(input.tenants)) {
    throw new UnprocessableEntityException('Provide a username, a password of at least 12 characters, and tenant assignments');
  }
  if (input.tenants.length === 0) {
    throw new UnprocessableEntityException('Regular users need at least one tenant assignment');
  }
  const tenantIds = new Set<string>();
  for (const assignment of input.tenants) {
    if (!assignment || typeof assignment.tenantId !== 'string' || !assignment.tenantId.trim()) {
      throw new UnprocessableEntityException(`Each tenant assignment needs tenantId`);
    }
    if (!isTenantRole(assignment.role)) {
      throw new UnprocessableEntityException(`Request tenant role(${assignment.role ? assignment.role : 'undefined'}) is invalid`);
    }
    if (tenantIds.has(assignment.tenantId.trim())) throw new UnprocessableEntityException('Each tenant can be assigned only once per user');
    tenantIds.add(assignment.tenantId.trim());
  }
}

function safeEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(createHash('sha256').update(actual).digest(), createHash('sha256').update(expected).digest());
}

function publicUser(user: { id: string; username: string; role: string | null; tenantRoles: TenantAssignment[] }) {
  return user.role === USER_ROLE.SUPER_ADMIN
    ? { id: user.id, username: user.username, role: USER_ROLE.SUPER_ADMIN, tenantRoles: [] }
    : { id: user.id, username: user.username, tenantRoles: user.tenantRoles };
}
