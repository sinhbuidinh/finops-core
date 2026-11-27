import { ConflictException, Injectable, Inject, NotFoundException } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { POSTGRES_POOL } from '../database/database.module.js';
import { USER_ROLE, type TenantRole } from './user-role.js';

export interface TenantAssignment { tenantId: string; role: TenantRole; }

export interface AuthUser {
  id: string;
  username: string;
  passwordHash: string;
  role: string | null;
  tenantRoles: TenantAssignment[];
  active: boolean;
}

@Injectable()
export class AuthUserRepository {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  async findByUsername(username: string): Promise<AuthUser | undefined> {
    const result = await this.pool.query<UserRow>(
      `SELECT u.id, u.username, u.password_hash, u.role, u.active,
              COALESCE(json_agg(json_build_object('tenantId', t.tenant_id, 'role', t.role))
                FILTER (WHERE t.tenant_id IS NOT NULL), '[]') AS tenant_roles
         FROM auth_users u LEFT JOIN auth_user_tenants t ON t.user_id = u.id
        WHERE u.username = $1 GROUP BY u.id`, [normalizeUsername(username)],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async findById(id: string): Promise<AuthUser | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) return undefined;
    const result = await this.pool.query<UserRow>(
      `SELECT u.id, u.username, u.password_hash, u.role, u.active,
              COALESCE(json_agg(json_build_object('tenantId', t.tenant_id, 'role', t.role))
                FILTER (WHERE t.tenant_id IS NOT NULL), '[]') AS tenant_roles
         FROM auth_users u LEFT JOIN auth_user_tenants t ON t.user_id = u.id
        WHERE u.id = $1 GROUP BY u.id`, [id],
    );
    return result.rows[0] ? mapUser(result.rows[0]) : undefined;
  }

  async listByTenant(tenantId: string): Promise<AuthUser[]> {
    const result = await this.pool.query<UserRow>(
      `SELECT u.id, u.username, u.password_hash, u.role, u.active,
              json_agg(json_build_object('tenantId', t.tenant_id, 'role', t.role)) AS tenant_roles
         FROM auth_users u JOIN auth_user_tenants t ON t.user_id = u.id
        WHERE t.tenant_id = $1 GROUP BY u.id ORDER BY u.username`, [tenantId],
    );
    return result.rows.map(mapUser);
  }

  async updateTenantRole(userId: string, tenantId: string, role: TenantRole): Promise<AuthUser> {
    const result = await this.pool.query(
      'UPDATE auth_user_tenants SET role = $3 WHERE user_id = $1 AND tenant_id = $2', [userId, tenantId, role],
    );
    if (result.rowCount !== 1) throw new NotFoundException('User is not assigned to this tenant');
    const user = await this.findById(userId);
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async create(input: { username: string; passwordHash: string; role: null; tenantRoles: TenantAssignment[] }): Promise<AuthUser> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const user = await this.insertUser(client, input);
      await client.query('COMMIT');
      return user;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) throw new ConflictException('Username already exists');
      throw error;
    } finally {
      client.release();
    }
  }

  async bootstrap(input: { username: string; passwordHash: string }): Promise<AuthUser> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(77419921)');
      const existing = await client.query<{ exists: boolean }>(
        'SELECT EXISTS (SELECT 1 FROM auth_users WHERE role = $1) AS exists', [USER_ROLE.SUPER_ADMIN],
      );
      if (existing.rows[0]?.exists) throw new ConflictException('A super administrator account already exists');
      const user = await this.insertUser(client, { ...input, role: USER_ROLE.SUPER_ADMIN, tenantRoles: [] });
      await client.query('COMMIT');
      return user;
    } catch (error) {
      await client.query('ROLLBACK');
      if (isSuperAdminUniqueViolation(error)) throw new ConflictException('A super administrator account already exists');
      if (isUniqueViolation(error)) throw new ConflictException('Username already exists');
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertUser(client: PoolClient, input: { username: string; passwordHash: string; role: string | null; tenantRoles: TenantAssignment[] }): Promise<AuthUser> {
    const inserted = await client.query<{ id: string; username: string; role: string | null; active: boolean }>(
      `INSERT INTO auth_users (username, password_hash, role)
       VALUES ($1, $2, $3) RETURNING id, username, role, active`,
      [normalizeUsername(input.username), input.passwordHash, input.role],
    );
    const row = inserted.rows[0]!;
    const tenantRoles = input.tenantRoles.map(({ tenantId, role }) => ({ tenantId: tenantId.trim(), role }));
    if (tenantRoles.length) {
      await client.query(
        `INSERT INTO auth_user_tenants (user_id, tenant_id, role)
         SELECT $1, assignment.tenant_id, assignment.role
           FROM unnest($2::text[], $3::text[]) AS assignment(tenant_id, role)`,
        [row.id, tenantRoles.map((assignment) => assignment.tenantId), tenantRoles.map((assignment) => assignment.role)],
      );
    }
    return { ...row, passwordHash: input.passwordHash, tenantRoles, active: row.active };
  }
}

interface UserRow { id: string; username: string; password_hash: string; role: string | null; active: boolean; tenant_roles: TenantAssignment[]; }
function mapUser(row: UserRow): AuthUser {
  const tenantRoles = row.tenant_roles ?? [];
  return { id: row.id, username: row.username, passwordHash: row.password_hash, role: row.role, active: row.active, tenantRoles };
}
function normalizeUsername(username: string): string { return username.trim().toLowerCase(); }
function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
function isSuperAdminUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'constraint' in error && error.constraint === 'auth_users_single_super_admin_idx';
}
