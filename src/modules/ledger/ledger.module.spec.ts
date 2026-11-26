import type { Provider } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module.js';
import { LEDGER_ENTRY_REPOSITORY } from './application/ledger-entry-repository.port.js';
import { PostJournalEntryUseCase } from './application/post-journal-entry.use-case.js';
import { ReverseJournalEntryUseCase } from './application/reverse-journal-entry.use-case.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerModule } from './ledger.module.js';
import { LedgerService } from './ledger.service.js';
import { PostgresLedgerEntryRepository } from './infrastructure/postgres-ledger-entry.repository.js';

describe('LedgerModule', () => {
  it('wires the repository, use cases, service, and controller', async () => {
    const providers = Reflect.getMetadata('providers', LedgerModule) as Provider[];
    const controllers = Reflect.getMetadata('controllers', LedgerModule) as unknown[];
    const imports = Reflect.getMetadata('imports', LedgerModule) as unknown[];
    const exports = Reflect.getMetadata('exports', LedgerModule) as unknown[];
    const repository = new PostgresLedgerEntryRepository({} as never);
    const postProvider = providers.find((provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === PostJournalEntryUseCase);
    const reverseProvider = providers.find((provider) => typeof provider === 'object' && 'provide' in provider && provider.provide === ReverseJournalEntryUseCase);

    expect(providers).toContain(PostgresLedgerEntryRepository);
    expect(providers).toContain(LedgerService);
    expect(providers).toContainEqual({ provide: LEDGER_ENTRY_REPOSITORY, useExisting: PostgresLedgerEntryRepository });
    expect((postProvider as { useFactory: (repo: PostgresLedgerEntryRepository) => PostJournalEntryUseCase }).useFactory(repository))
      .toBeInstanceOf(PostJournalEntryUseCase);
    expect((reverseProvider as { useFactory: (repo: PostgresLedgerEntryRepository) => ReverseJournalEntryUseCase }).useFactory(repository))
      .toBeInstanceOf(ReverseJournalEntryUseCase);
    expect(controllers).toContain(LedgerController);
    expect(imports).toContain(DatabaseModule);
    expect(exports).toEqual([PostgresLedgerEntryRepository, PostJournalEntryUseCase, ReverseJournalEntryUseCase, LedgerService]);
  });
});
