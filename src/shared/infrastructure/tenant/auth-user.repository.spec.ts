import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Pool } from 'pg';
import { AuthUserRepository } from './auth-user.repository.js';
import { USER_ROLE } from './user-role.js';

describe('AuthUserRepository.bootstrap', () => {
  it('rejects bootstrap when a super administrator already exists', async () => {
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: true }] })
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const repository = new AuthUserRepository({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);

    await expect(repository.bootstrap({ username: 'root', passwordHash: 'hashed' })).rejects.toThrow(ConflictException);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT EXISTS (SELECT 1 FROM auth_users WHERE role = $1) AS exists', [USER_ROLE.SUPER_ADMIN],
    );
    expect(client.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO auth_users'), expect.anything());
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('maps a concurrent singleton-index conflict to an existing-admin conflict', async () => {
    const duplicate = Object.assign(new Error('duplicate super admin'), {
      code: '23505', constraint: 'auth_users_single_super_admin_idx',
    });
    const client = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ exists: false }] })
        .mockRejectedValueOnce(duplicate)
        .mockResolvedValueOnce({ rows: [] }),
      release: vi.fn(),
    };
    const repository = new AuthUserRepository({ connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);

    await expect(repository.bootstrap({ username: 'root', passwordHash: 'hashed' }))
      .rejects.toThrow('A super administrator account already exists');
    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('AuthUserRepository', () => {
  const row = { id: 'id-1', username: 'staff', password_hash: 'hash', role: null, active: true, tenant_roles: null };

  it('normalizes usernames, maps users, and returns undefined when no match exists', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] }) };
    const repository = new AuthUserRepository(pool as never);
    await expect(repository.findByUsername(' STAFF ')).resolves.toMatchObject({ username: 'staff', passwordHash: 'hash', tenantRoles: [] });
    expect(pool.query.mock.calls[0]?.[1]).toEqual(['staff']);
    await expect(repository.findByUsername('missing')).resolves.toBeUndefined();
  });

  it('validates ids, maps found users, and returns an empty tenant list when there are no rows', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [] }) };
    const repository = new AuthUserRepository(pool as never);
    await expect(repository.findById('not-a-uuid')).resolves.toBeUndefined();
    expect(pool.query).not.toHaveBeenCalled();
    await expect(repository.findById('123e4567-e89b-42d3-a456-426614174000')).resolves.toMatchObject({ id: 'id-1' });
    await expect(repository.listByTenant('tenant-1')).resolves.toEqual([]);
  });

  it('returns undefined when a valid user id has no matching row', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const repository = new AuthUserRepository(pool as never);
    await expect(repository.findById('123e4567-e89b-42d3-a456-426614174000')).resolves.toBeUndefined();
  });

  it('updates assigned roles and reports missing assignments and users', async () => {
    const pool = { query: vi.fn().mockResolvedValueOnce({ rowCount: 0 }).mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 }) };
    const repository = new AuthUserRepository(pool as never);
    await expect(repository.updateTenantRole('u', 't', USER_ROLE.OPERATOR)).rejects.toThrow(NotFoundException);
    vi.spyOn(repository, 'findById').mockResolvedValueOnce(undefined);
    await expect(repository.updateTenantRole('u', 't', USER_ROLE.OPERATOR)).rejects.toThrow('User not found');
    vi.spyOn(repository, 'findById').mockResolvedValueOnce({ id: 'u', username: 'staff', passwordHash: 'hash', role: null, active: true, tenantRoles: [] });
    await expect(repository.updateTenantRole('u', 't', USER_ROLE.OPERATOR)).resolves.toMatchObject({ id: 'u' });
  });

  it('creates users and tenant assignments transactionally', async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...row, tenant_roles: undefined }] })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }), release: vi.fn() };
    const repository = new AuthUserRepository({ connect: vi.fn().mockResolvedValue(client) } as never);
    await expect(repository.create({ username: ' STAFF ', passwordHash: 'hash', role: null, tenantRoles: [{ tenantId: ' tenant-1 ', role: USER_ROLE.OPERATOR }] }))
      .resolves.toMatchObject({ username: 'staff', tenantRoles: [{ tenantId: 'tenant-1' }] });
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back failed creates and maps duplicate usernames', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: '23505' });
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(duplicate).mockResolvedValueOnce({ rows: [] }), release: vi.fn() };
    const repository = new AuthUserRepository({ connect: vi.fn().mockResolvedValue(client) } as never);
    await expect(repository.create({ username: 'staff', passwordHash: 'hash', role: null, tenantRoles: [] })).rejects.toThrow(ConflictException);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back unexpected bootstrap failures and maps username conflicts', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] }).mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [] }), release: vi.fn() };
    const repository = new AuthUserRepository({ connect: vi.fn().mockResolvedValue(client) } as never);
    await expect(repository.bootstrap({ username: 'root', passwordHash: 'hash' })).rejects.toThrow('Username already exists');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('creates a super administrator when bootstrap is available', async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ exists: false }] }).mockResolvedValueOnce({ rows: [{ id: 'root-id', username: 'root', role: USER_ROLE.SUPER_ADMIN, active: true }] })
      .mockResolvedValueOnce({ rows: [] }), release: vi.fn() };
    const repository = new AuthUserRepository({ connect: vi.fn().mockResolvedValue(client) } as never);
    await expect(repository.bootstrap({ username: 'root', passwordHash: 'hash' }))
      .resolves.toMatchObject({ id: 'root-id', role: USER_ROLE.SUPER_ADMIN, tenantRoles: [] });
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rethrows unexpected create failures after rollback', async () => {
    const failure = new Error('database unavailable');
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(failure).mockResolvedValueOnce({ rows: [] }), release: vi.fn() };
    const repository = new AuthUserRepository({ connect: vi.fn().mockResolvedValue(client) } as never);
    await expect(repository.create({ username: 'staff', passwordHash: 'hash', role: null, tenantRoles: [] })).rejects.toBe(failure);
  });
});
