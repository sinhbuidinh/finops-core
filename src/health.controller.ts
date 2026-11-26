import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { POSTGRES_POOL } from './shared/infrastructure/database/database.module.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(POSTGRES_POOL) private readonly pool: Pool) {}

  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ok' }> {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Database is not ready');
    }
  }
}
