import { existsSync } from 'node:fs';
import { describe } from 'vitest';

if (!process.env.INVENTORY_TEST_DATABASE_URL && existsSync('.env')) {
  process.loadEnvFile('.env');
}

export function resolveTestDatabaseUrl(
  configuredDatabaseUrl: string | undefined,
  databaseHost: string | undefined,
): string | undefined {
  // Inside Compose, loopback points to the API container. Use the PostgreSQL
  // service DNS name when the configured test URL still contains a loopback host.
  if (!configuredDatabaseUrl || databaseHost !== 'postgres')
    return configuredDatabaseUrl;

  const databaseUrl = new URL(configuredDatabaseUrl);
  if (
    databaseUrl.hostname === '127.0.0.1' ||
    databaseUrl.hostname === 'localhost'
  ) {
    databaseUrl.hostname = 'postgres';
  }
  return databaseUrl.toString();
}

const configuredDatabaseUrl = resolveTestDatabaseUrl(
  process.env.INVENTORY_TEST_DATABASE_URL,
  process.env.DB_HOST,
);
if (configuredDatabaseUrl)
  process.env.INVENTORY_TEST_DATABASE_URL = configuredDatabaseUrl;

export const testDatabaseUrl = process.env.INVENTORY_TEST_DATABASE_URL;

export function describeWithTestDatabase(
  name: string,
  suite: () => void,
): void {
  const databaseDescribe = testDatabaseUrl ? describe : describe.skip;
  databaseDescribe(name, suite);
}
