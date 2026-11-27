import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantRequestStore {
  tenantId?: string;
}

export class TenantContext {
  private readonly storage = new AsyncLocalStorage<TenantRequestStore>();

  run<T>(callback: () => T): T {
    return this.storage.run({}, callback);
  }

  setTenantId(tenantId: string): void {
    const store = this.storage.getStore();
    if (!store) throw new Error('Tenant context middleware is not registered');
    store.tenantId = tenantId;
  }

  requireTenantId(): string {
    const tenantId = this.storage.getStore()?.tenantId;
    if (!tenantId) throw new Error('Authenticated tenant context is missing');
    return tenantId;
  }
}
