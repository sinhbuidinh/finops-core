import { resolveTestDatabaseUrl } from './test-database.js';

describe('resolveTestDatabaseUrl', () => {
  it.each(['127.0.0.1', 'localhost'])(
    'uses the Compose PostgreSQL host for loopback URL %s',
    (hostname) => {
      const url = `postgresql://user:password@${hostname}:5432/test_db`;

      expect(new URL(resolveTestDatabaseUrl(url, 'postgres')!).hostname).toBe(
        'postgres',
      );
    },
  );

  it('preserves an explicit database host outside Compose', () => {
    const url = 'postgresql://user:password@db.example.test:5432/test_db';

    expect(resolveTestDatabaseUrl(url, undefined)).toBe(url);
  });

  it('keeps a missing test database URL missing', () => {
    expect(resolveTestDatabaseUrl(undefined, 'postgres')).toBeUndefined();
  });
});
