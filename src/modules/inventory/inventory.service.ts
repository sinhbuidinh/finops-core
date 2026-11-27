import { Inject, Injectable } from '@nestjs/common';
import { INVENTORY_REPOSITORY, type InventoryRepositoryPort } from './application/inventory-repository.port.js';
import { InventoryUseCase } from './application/inventory.use-case.js';

@Injectable()
export class InventoryService {
  private readonly useCase: InventoryUseCase;
  constructor(@Inject(INVENTORY_REPOSITORY) repository: InventoryRepositoryPort) {
    this.useCase = new InventoryUseCase(repository);
  }
  createItem(input: { tenantId: string; id: string; totalQty: number }) { return this.useCase.createItem(input); }
  getItem(tenantId: string, id: string) { return this.useCase.getItem(tenantId, id); }
  reserve(tenantId: string, id: string, quantity: number, idempotencyKey?: string) { return this.useCase.reserve(tenantId, id, quantity, idempotencyKey); }
  release(tenantId: string, id: string) { return this.useCase.release(tenantId, id); }
}
