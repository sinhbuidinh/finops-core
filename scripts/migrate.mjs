import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pool } from 'pg';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(projectRoot, 'src/shared/infrastructure/database/migrations');
const migrationLockKey = 'finops-core:db-migrate';

export async function applyMigrations(pool, files, readMigration, { baseline = false, log = console.log } = {}) {
  const migrations = files.filter((file) => file.endsWith('.sql')).sort((a, b) => a.localeCompare(b, 'en'));
  if (migrations.length === 0) {
    log('No SQL migrations found.');
    return { applied: 0, skipped: 0 };
  }

  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [migrationLockKey]);
    lockAcquired = true;
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    const result = await client.query('SELECT migration_name FROM schema_migrations');
    const appliedMigrations = new Set(result.rows.map((row) => row.migration_name));

    if (baseline) {
      if (appliedMigrations.size > 0) {
        throw new Error('Cannot baseline a database that already has migration history.');
      }
      await client.query('BEGIN');
      try {
        for (const file of migrations) {
          await client.query('INSERT INTO schema_migrations (migration_name) VALUES ($1)', [file]);
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      log(`Baselined ${migrations.length} existing SQL migration(s).`);
      return { applied: 0, skipped: migrations.length };
    }

    let applied = 0;
    let skipped = 0;
    for (const file of migrations) {
      if (appliedMigrations.has(file)) {
        skipped++;
        log(`Skipping ${file}; already applied.`);
        continue;
      }

      log(`Applying ${file}...`);
      const sql = await readMigration(file);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (migration_name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied++;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    log(`Applied ${applied} new SQL migration(s); skipped ${skipped} already applied.`);
    return { applied, skipped };
  } finally {
    if (lockAcquired) {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [migrationLockKey]).catch(() => undefined);
    }
    client.release();
  }
}

async function main() {
  const files = await readdir(migrationsDir);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    host: process.env.DB_HOST ?? 'localhost',
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? 'postgres',
    database: process.env.DB_NAME ?? 'finops_core',
  });

  try {
    await applyMigrations(pool, files, (file) => readFile(join(migrationsDir, file), 'utf8'), {
      baseline: process.argv.includes('--baseline'),
    });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
