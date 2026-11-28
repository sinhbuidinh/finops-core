import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { DomainValidationError } from '../../shared/domain/domain-error.js';
import { PostJournalEntryUseCase } from './application/post-journal-entry.use-case.js';
import { ReverseJournalEntryUseCase } from './application/reverse-journal-entry.use-case.js';
import type { JournalEntryInput } from './domain/journal-entry.js';
import type { LedgerIdempotencyContext } from './application/ledger-entry-repository.port.js';
import { JournalEntry } from './domain/journal-entry.js';
import { Money } from '../../shared/domain/money.js';
import { NotFoundException } from '@nestjs/common';
import { PostgresLedgerEntryRepository } from './infrastructure/postgres-ledger-entry.repository.js';

@Injectable()
export class LedgerService {
  constructor(
    private readonly postEntry: PostJournalEntryUseCase,
    private readonly reverseEntry: ReverseJournalEntryUseCase,
    private readonly entries: PostgresLedgerEntryRepository,
  ) {}

  post(input: JournalEntryInput, key: string, tenantId?: string) {
    return this.postEntry.execute(input, this.idempotency('ledger:post', key, { tenantId, input }), tenantId);
  }

  async createWallet(tenantId: string, walletId: string, name: string) {
    await this.entries.createWallet({ tenantId, walletId, name });
    return { walletId, tenantId };
  }

  findWallet(walletId: string, tenantId: string) { return this.entries.findWallet(walletId, tenantId); }

  async postWalletPayment(input: { tenantId: string; walletId: string; entryId: string; description: string; postedAt?: string; amount: { minorUnits: string; currency: string } }, key: string) {
    const wallet = await this.entries.findWallet(input.walletId, input.tenantId);
    if (!wallet) throw new NotFoundException('Wallet not found');
    const entry = JournalEntry.create({
      id: input.entryId, description: input.description,
      postedAt: input.postedAt ? new Date(input.postedAt) : undefined,
      lines: [
        { accountId: 'platform:order-clearing', side: 'DEBIT', amount: Money.fromMinorUnits(BigInt(input.amount.minorUnits), input.amount.currency) },
        { accountId: wallet.ledgerAccountId, side: 'CREDIT', amount: Money.fromMinorUnits(BigInt(input.amount.minorUnits), input.amount.currency) },
      ],
    });
    return this.postEntry.execute(entry, this.idempotency('ledger:post', key, { tenantId: input.tenantId, entry }), input.tenantId);
  }

  reverse(originalEntryId: string, reversalEntryId: string, key: string, tenantId?: string) {
    const request = { originalEntryId, reversalEntryId };
    return this.reverseEntry.execute({
      ...request,
      tenantId,
      idempotency: this.idempotency('ledger:reverse', key, { tenantId, request }),
    });
  }

  getBalance(accountId: string, tenantId: string) {
    return this.entries.getBalance(accountId, tenantId);
  }

  async getHistory(cursor: string | undefined, requestedLimit: string | undefined, tenantId: string) {
    const limit = requestedLimit === undefined ? 50 : Number(requestedLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainValidationError('limit must be an integer between 1 and 100', 'INVALID_PAGE_SIZE');
    }
    const after = cursor ? decodeCursor(cursor) : undefined;
    const entries = await this.entries.getHistory({ after, limit: limit + 1, tenantId });
    const hasMore = entries.length > limit;
    const items = entries.slice(0, limit);
    return {
      items,
      nextCursor: hasMore && items.length ? encodeCursor(items[items.length - 1]!) : null,
    };
  }

  private idempotency(scope: string, key: string, payload: unknown): LedgerIdempotencyContext {
    const fingerprint = createHash('sha256').update(stableJson(payload)).digest('hex');
    return { scope, key, fingerprint };
  }
}

function stableJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function encodeCursor(entry: { readonly id: string; readonly postedAt: Date }): string {
  return Buffer.from(JSON.stringify({ id: entry.id, postedAt: entry.postedAt.toISOString() })).toString('base64url');
}

function decodeCursor(cursor: string): { id: string; postedAt: Date } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { id?: unknown; postedAt?: unknown };
    const postedAt = new Date(String(parsed.postedAt));
    if (typeof parsed.id !== 'string' || !parsed.id || Number.isNaN(postedAt.getTime())) throw new Error();
    return { id: parsed.id, postedAt };
  } catch {
    throw new DomainValidationError('Invalid journal history cursor', 'INVALID_JOURNAL_CURSOR');
  }
}
