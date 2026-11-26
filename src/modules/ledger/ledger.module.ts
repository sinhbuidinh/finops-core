import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../shared/infrastructure/database/database.module.js';
import { PostJournalEntryUseCase } from './application/post-journal-entry.use-case.js';
import { ReverseJournalEntryUseCase } from './application/reverse-journal-entry.use-case.js';
import { LEDGER_ENTRY_REPOSITORY } from './application/ledger-entry-repository.port.js';
import { LedgerController } from './ledger.controller.js';
import { LedgerService } from './ledger.service.js';
import { PostgresLedgerEntryRepository } from './infrastructure/postgres-ledger-entry.repository.js';

@Module({
  imports: [DatabaseModule],
  controllers: [LedgerController],
  providers: [
    PostgresLedgerEntryRepository,
    {
      provide: LEDGER_ENTRY_REPOSITORY,
      useExisting: PostgresLedgerEntryRepository,
    },
    {
      provide: PostJournalEntryUseCase,
      useFactory: (repository: PostgresLedgerEntryRepository) => new PostJournalEntryUseCase(repository),
      inject: [LEDGER_ENTRY_REPOSITORY],
    },
    {
      provide: ReverseJournalEntryUseCase,
      useFactory: (repository: PostgresLedgerEntryRepository) => new ReverseJournalEntryUseCase(repository),
      inject: [LEDGER_ENTRY_REPOSITORY],
    },
    LedgerService,
  ],
  exports: [PostgresLedgerEntryRepository, PostJournalEntryUseCase, ReverseJournalEntryUseCase, LedgerService],
})
export class LedgerModule {}
