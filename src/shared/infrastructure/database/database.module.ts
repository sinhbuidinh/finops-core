import {
  Global,
  Injectable,
  Module,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Pool } from 'pg';

export const POSTGRES_POOL = Symbol('POSTGRES_POOL');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'postgres',
  password: process.env.DB_PASSWORD ?? 'postgres',
  database: process.env.DB_NAME ?? 'finops_core',
  max: Number(process.env.DB_POOL_MAX ?? 10),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

@Injectable()
class PoolLifecycle implements OnModuleDestroy {
  onModuleDestroy(): Promise<void> {
    return pool.end();
  }
}

@Global()
@Module({
  providers: [PoolLifecycle, { provide: POSTGRES_POOL, useValue: pool }],
  exports: [POSTGRES_POOL],
})
export class DatabaseModule {}
