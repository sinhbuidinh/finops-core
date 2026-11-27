import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { CurrentTenantId } from './current-tenant.decorator.js';

class DecoratedHandler {
  readTenant(@CurrentTenantId() _tenantId: string): void {}
}

describe('CurrentTenantId', () => {
  it('reads the tenant ID from the HTTP request', () => {
    const routeArgs = Reflect.getMetadata(ROUTE_ARGS_METADATA, DecoratedHandler, 'readTenant') as Record<
      string,
      { factory: (data: unknown, context: unknown) => string }
    >;
    const customParam = Object.values(routeArgs).find(({ factory }) => typeof factory === 'function');
    const context = { switchToHttp: () => ({ getRequest: () => ({ tenantId: 'tenant-1' }) }) };

    expect(customParam?.factory(undefined, context)).toBe('tenant-1');
  });
});
