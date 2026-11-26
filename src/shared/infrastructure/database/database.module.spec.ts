import { Test } from '@nestjs/testing';

const { pool } = vi.hoisted(() => ({
  pool: { end: vi.fn().mockResolvedValue(undefined), query: vi.fn() },
}));

vi.mock('pg', () => ({
  Pool: class {
    constructor() { return pool; }
  },
}));

import { DatabaseModule, POSTGRES_POOL } from './database.module.js';

describe('DatabaseModule', () => {
  it('provides one pool and closes it with the Nest module lifecycle', async () => {
    const module = await Test.createTestingModule({ imports: [DatabaseModule] }).compile();
    expect(module.get(POSTGRES_POOL)).toBe(pool);
    await module.close();
    expect(pool.end).toHaveBeenCalledOnce();
  });
});
