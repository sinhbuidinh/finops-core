import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(
  projectRoot,
  'src/shared/infrastructure/database/migrations',
);
const files = (await readdir(migrationsDir))
  .filter((file) => file.endsWith('.sql'))
  .sort((a, b) => a.localeCompare(b, 'en'));
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'finops_core',
});

if (files.length === 0) {
  console.log('No SQL migrations found.');
  await pool.end();
  process.exit(0);
}

try {
  for (const file of files) {
    console.log(`Applying ${file}...`);
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  console.log(`Applied ${files.length} SQL migration(s).`);
} finally {
  await pool.end();
}
