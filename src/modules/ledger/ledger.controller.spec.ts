import { BadRequestException } from '@nestjs/common';
import { JOURNAL_SIDES } from './domain/journal-entry.js';
import { LedgerController } from './ledger.controller.js';

describe('LedgerController', () => {
  function setup() {
    const ledger = {
      post: vi.fn().mockResolvedValue({ id: 'entry-1' }),
      createWallet: vi.fn().mockResolvedValue({ walletId: 'wallet-1', tenantId: 'tenant-1' }),
      findWallet: vi.fn().mockResolvedValue({ walletId: 'wallet-1', ledgerAccountId: 'wallet-account:wallet-1' }),
      reverse: vi.fn().mockResolvedValue({ id: 'entry-2' }),
      getBalance: vi.fn().mockResolvedValue([]),
      getHistory: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    return { controller: new LedgerController(ledger as never), ledger };
  }

  const validEntry = {
    id: 'entry-1',
    description: 'Sale',
    lines: [
      { accountId: 'cash', side: JOURNAL_SIDES.DEBIT, amount: { minorUnits: '10', currency: 'USD' } },
      { accountId: 'revenue', side: JOURNAL_SIDES.CREDIT, amount: { minorUnits: '10', currency: 'USD' } },
    ],
  };

  it('parses and posts an entry with a required idempotency key', async () => {
    const { controller, ledger } = setup();
    await controller.postEntry('tenant-1', validEntry, ' key-1 ');
    const [input, key] = ledger.post.mock.calls[0]!;
    expect(key).toBe('key-1');
    expect(input.lines[0].amount.minorUnits).toBe(10n);
    expect(ledger.post).toHaveBeenCalledOnce();
  });

  it('rejects invalid request bodies, line fields, amounts, and idempotency keys', () => {
    const { controller } = setup();
    expect(() => controller.postEntry('tenant-1', null, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', {}, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', { ...validEntry, lines: [null] }, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', { ...validEntry, lines: [{ ...validEntry.lines[0], side: 'OTHER' }] }, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', { ...validEntry, lines: [{ ...validEntry.lines[0], amount: { minorUnits: 1, currency: 'USD' } }] }, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', { ...validEntry, lines: [{ ...validEntry.lines[0], accountId: 1 }] }, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', { ...validEntry, lines: [{ ...validEntry.lines[0], amount: null }] }, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', { ...validEntry, lines: [{ ...validEntry.lines[0], amount: { minorUnits: '1.5', currency: 'USD' } }] }, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', { ...validEntry, lines: [{ ...validEntry.lines[0], amount: { minorUnits: '1', currency: 1 } }] }, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', { ...validEntry, lines: [{ ...validEntry.lines[0], memo: 1 }] }, 'key')).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', validEntry, undefined)).toThrow(BadRequestException);
    expect(() => controller.postEntry('tenant-1', validEntry, 'x'.repeat(201))).toThrow(BadRequestException);
  });

  it('validates and delegates reversal and read requests', async () => {
    const { controller, ledger } = setup();
    expect(() => controller.reverseEntry('tenant-1', 'entry-1', null, 'key')).toThrow(BadRequestException);
    expect(() => controller.reverseEntry('tenant-1', 'entry-1', {}, 'key')).toThrow(BadRequestException);
    expect(() => controller.reverseEntry('tenant-1', 'entry-1', { reversalEntryId: ' ' }, 'key')).toThrow(BadRequestException);
    await controller.reverseEntry('tenant-1', 'entry-1', { reversalEntryId: 'entry-2' }, 'key');
    await controller.getBalance('tenant-1', 'cash');
    await controller.getHistory('tenant-1', 'cursor', '10');
    expect(ledger.reverse).toHaveBeenCalledWith('entry-1', 'entry-2', 'key', 'tenant-1');
    expect(ledger.getBalance).toHaveBeenCalledWith('cash', 'tenant-1');
    expect(ledger.getHistory).toHaveBeenCalledWith('cursor', '10', 'tenant-1');
  });

  it('validates wallet creation and returns a wallet balance for the tenant', async () => {
    const { controller, ledger } = setup();
    expect(() => controller.createWallet('tenant-1', null)).toThrow(BadRequestException);
    expect(() => controller.createWallet('tenant-1', { walletId: ' ', name: 'Wallet' })).toThrow(BadRequestException);
    expect(() => controller.createWallet('tenant-1', { walletId: 'wallet-1', name: '' })).toThrow(BadRequestException);

    await controller.createWallet('tenant-1', { walletId: ' wallet-1 ', name: ' Main ' });
    expect(ledger.createWallet).toHaveBeenCalledWith('tenant-1', 'wallet-1', 'Main');
    await controller.getWalletBalance('tenant-1', 'wallet-1');
    expect(ledger.findWallet).toHaveBeenCalledWith('wallet-1', 'tenant-1');
    expect(ledger.getBalance).toHaveBeenCalledWith('wallet-account:wallet-1', 'tenant-1');

    ledger.findWallet.mockResolvedValueOnce(null);
    await expect(controller.getWalletBalance('tenant-1', 'missing')).rejects.toThrow('Wallet not found');
  });
});
