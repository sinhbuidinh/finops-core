import { TenantContext } from './tenant-context.js';

describe('TenantContext', () => {
  it('requires an active middleware scope before setting or reading a tenant', () => {
    const context = new TenantContext();
    expect(() => context.setTenantId('tenant-1')).toThrow('Tenant context middleware is not registered');
    expect(() => context.requireTenantId()).toThrow('Authenticated tenant context is missing');
  });

  it('stores a tenant only within its async request scope', () => {
    const context = new TenantContext();
    expect(context.run(() => {
      context.setTenantId('tenant-1');
      return context.requireTenantId();
    })).toBe('tenant-1');
    expect(() => context.requireTenantId()).toThrow('Authenticated tenant context is missing');
  });
});
