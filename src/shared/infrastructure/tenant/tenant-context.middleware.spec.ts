import { TenantContextMiddleware } from './tenant-context.middleware.js';
import { TenantContext } from './tenant-context.js';

describe('TenantContextMiddleware', () => {
  it('runs the next handler inside a fresh tenant context', () => {
    const context = new TenantContext();
    const middleware = new TenantContextMiddleware(context);
    const next = vi.fn(() => context.setTenantId('tenant-1'));
    middleware.use({} as never, {} as never, next);
    expect(next).toHaveBeenCalledOnce();
    expect(() => context.requireTenantId()).toThrow('Authenticated tenant context is missing');
  });
});
