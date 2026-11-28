import { applyMigrations } from './migrate.mjs';

describe('applyMigrations', () => {
  function makePool(query: ReturnType<typeof vi.fn>) {
    const release = vi.fn();
    const client = { query, release };
    return {
      pool: { connect: vi.fn().mockResolvedValue(client) },
      client,
      release,
    };
  }

  it('returns without connecting when there are no SQL migrations', async () => {
    const connect = vi.fn();
    const log = vi.fn();

    await expect(
      applyMigrations({ connect } as never, ['README.md'], vi.fn(), { log }),
    ).resolves.toEqual({ applied: 0, skipped: 0 });

    expect(connect).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('No SQL migrations found.');
  });

  it('skips recorded migrations and records a new migration in the same transaction', async () => {
    const query = vi.fn(async (sql: string) =>
      sql === 'SELECT migration_name FROM schema_migrations'
        ? { rows: [{ migration_name: '001_initial.sql' }] }
        : { rows: [], rowCount: 1 },
    );
    const { pool, client, release } = makePool(query);
    const readMigration = vi
      .fn()
      .mockResolvedValue('CREATE TABLE example (id integer);');
    const log = vi.fn();

    await expect(
      applyMigrations(
        pool as never,
        ['002_next.sql', '001_initial.sql'],
        readMigration,
        { log },
      ),
    ).resolves.toEqual({ applied: 1, skipped: 1 });

    expect(readMigration).toHaveBeenCalledExactlyOnceWith('002_next.sql');
    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements).toContain('BEGIN');
    expect(statements).toContain('CREATE TABLE example (id integer);');
    expect(
      query.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO schema_migrations'),
      ),
    ).toEqual([
      'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
      ['002_next.sql'],
    ]);
    expect(statements).toContain('COMMIT');
    expect(query.mock.calls[0]?.[0]).toContain('pg_advisory_lock');
    expect(query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock');
    expect(log).toHaveBeenCalledWith(
      'Skipping 001_initial.sql; already applied.',
    );
    expect(release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('rolls back a failed migration without recording it', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT migration_name FROM schema_migrations')
        return { rows: [] };
      if (sql === 'BROKEN SQL') throw new Error('migration failed');
      return { rows: [], rowCount: 1 };
    });
    const { pool, release } = makePool(query);

    await expect(
      applyMigrations(
        pool as never,
        ['001_broken.sql'],
        async () => 'BROKEN SQL',
        { log: vi.fn() },
      ),
    ).rejects.toThrow('migration failed');

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO schema_migrations'),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('baselines an existing database without executing migration SQL', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const { pool } = makePool(query);
    const readMigration = vi.fn();

    await expect(
      applyMigrations(
        pool as never,
        ['002_next.sql', '001_initial.sql'],
        readMigration,
        { baseline: true, log: vi.fn() },
      ),
    ).resolves.toEqual({ applied: 0, skipped: 2 });

    expect(readMigration).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
      ['001_initial.sql'],
    );
    expect(query).toHaveBeenCalledWith(
      'INSERT INTO schema_migrations (migration_name) VALUES ($1)',
      ['002_next.sql'],
    );
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('refuses to baseline a database with existing history', async () => {
    const query = vi.fn(async (sql: string) =>
      sql === 'SELECT migration_name FROM schema_migrations'
        ? { rows: [{ migration_name: '001_initial.sql' }] }
        : { rows: [], rowCount: 1 },
    );
    const { pool } = makePool(query);

    await expect(
      applyMigrations(pool as never, ['001_initial.sql'], vi.fn(), {
        baseline: true,
        log: vi.fn(),
      }),
    ).rejects.toThrow(
      'Cannot baseline a database that already has migration history',
    );
    expect(query).not.toHaveBeenCalledWith('BEGIN');
  });

  it('rolls back a failed baseline and still releases the advisory lock', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'INSERT INTO schema_migrations (migration_name) VALUES ($1)')
        throw new Error('baseline insert failed');
      if (sql === 'ROLLBACK') throw new Error('rollback failed');
      return { rows: [] };
    });
    const { pool, release } = makePool(query);

    await expect(
      applyMigrations(pool as never, ['001_initial.sql'], vi.fn(), {
        baseline: true,
        log: vi.fn(),
      }),
    ).rejects.toThrow('baseline insert failed');

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(query.mock.calls.at(-1)?.[0]).toContain('pg_advisory_unlock');
    expect(release).toHaveBeenCalledOnce();
  });

  it('releases the client without unlocking when lock acquisition fails', async () => {
    const query = vi.fn(async (sql: string) => {
      if (String(sql).includes('pg_advisory_lock'))
        throw new Error('lock failed');
      return { rows: [] };
    });
    const { pool, release } = makePool(query);

    await expect(
      applyMigrations(pool as never, ['001_initial.sql'], vi.fn(), {
        log: vi.fn(),
      }),
    ).rejects.toThrow('lock failed');

    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes('pg_advisory_unlock'),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});
