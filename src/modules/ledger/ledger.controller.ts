import {
  BadRequestException,
  NotFoundException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { CurrentTenantId } from '../../shared/infrastructure/tenant/current-tenant.decorator.js';
import { TenantAuthGuard } from '../../shared/infrastructure/tenant/tenant-auth.guard.js';
import { Money } from '../../shared/domain/money.js';
import { JOURNAL_SIDES, type JournalEntryInput, type JournalLine } from './domain/journal-entry.js';
import { LedgerService } from './ledger.service.js';

@Controller('ledger')
@UseGuards(TenantAuthGuard)
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Post('entries')
  postEntry(@CurrentTenantId() tenantId: string, @Body() body: unknown, @Headers('idempotency-key') key?: string) {
    return this.ledger.post(parseEntry(body), requireIdempotencyKey(key), tenantId);
  }

  @Post('wallets')
  @HttpCode(HttpStatus.CREATED)
  createWallet(@CurrentTenantId() tenantId: string, @Body() body: unknown) {
    const input = asRecord(body);
    if (typeof input.walletId !== 'string' || !input.walletId.trim() || typeof input.name !== 'string' || !input.name.trim()) throw new BadRequestException('walletId and name are required');
    return this.ledger.createWallet(tenantId, input.walletId.trim(), input.name.trim());
  }

  @Get('wallets/:walletId/balance')
  async getWalletBalance(@CurrentTenantId() tenantId: string, @Param('walletId') walletId: string) {
    const wallet = await this.ledger.findWallet(walletId, tenantId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    return this.ledger.getBalance(wallet.ledgerAccountId, tenantId);
  }

  @Post('entries/:entryId/reversals')
  reverseEntry(
    @CurrentTenantId() tenantId: string,
    @Param('entryId') entryId: string,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ) {
    const parsed = asRecord(body);
    if (typeof parsed.reversalEntryId !== 'string' || !parsed.reversalEntryId.trim()) {
      throw new BadRequestException('reversalEntryId is required');
    }
    return this.ledger.reverse(entryId, parsed.reversalEntryId, requireIdempotencyKey(key), tenantId);
  }

  @Get('accounts/:accountId/balance')
  getBalance(@CurrentTenantId() tenantId: string, @Param('accountId') accountId: string) {
    return this.ledger.getBalance(accountId, tenantId);
  }

  @Get('entries')
  getHistory(@CurrentTenantId() tenantId: string, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.ledger.getHistory(cursor, limit, tenantId);
  }
}

function requireIdempotencyKey(key: string | undefined): string {
  if (!key?.trim() || key.length > 200) throw new BadRequestException('A valid Idempotency-Key header is required');
  return key.trim();
}

function parseEntry(body: unknown): JournalEntryInput {
  const input = asRecord(body);
  if (typeof input.id !== 'string' || typeof input.description !== 'string' || !Array.isArray(input.lines)) {
    throw new BadRequestException('id, description, and lines are required');
  }
  const lines: JournalLine[] = input.lines.map((value) => {
    const line = asRecord(value);
    const amount = asRecord(line.amount);
    if (typeof line.accountId !== 'string' ||
        (line.side !== JOURNAL_SIDES.DEBIT && line.side !== JOURNAL_SIDES.CREDIT) ||
        typeof amount.minorUnits !== 'string' || !/^-?\d+$/.test(amount.minorUnits) ||
        typeof amount.currency !== 'string' ||
        (line.memo !== undefined && typeof line.memo !== 'string')) {
      throw new BadRequestException('Each line requires accountId, side, amount { minorUnits, currency }, and optional memo');
    }
    return {
      accountId: line.accountId,
      side: line.side,
      amount: Money.fromMinorUnits(BigInt(amount.minorUnits), amount.currency),
      memo: line.memo as string | undefined,
    };
  });
  return { id: input.id, description: input.description, lines };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Expected a JSON object');
  return value as Record<string, unknown>;
}
