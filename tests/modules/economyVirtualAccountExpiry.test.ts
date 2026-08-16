const mockExecuteRaw = jest.fn();
const mockQueryRaw = jest.fn();
const mockAssertEconomyScopeReady = jest.fn<Promise<void>, [unknown, unknown]>();

jest.mock('../../src/modules/economy/scopeMigration', () => ({
  assertEconomyScopeReady: mockAssertEconomyScopeReady,
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      $executeRawUnsafe: mockExecuteRaw,
      $queryRawUnsafe: mockQueryRaw,
    }),
    $executeRawUnsafe: mockExecuteRaw,
    $queryRawUnsafe: mockQueryRaw,
  },
}));

import { transferUserToVirtualAccount } from '../../src/modules/economy/virtualAccounts';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

const G = asGuildId('123456789012345678');
const C = asNitradoConnId('clx1234567890123456789012');
const U = asUserDiscordId('234567890123456789');

function account(status: 'ACTIVE' | 'EXPIRED', acceptUserTransfers: boolean) {
  return {
    id: 'virtual-1', guildId: String(G), nitradoConnId: String(C), kind: 'CUSTOM',
    name: 'Kasse', nameKey: 'kasse', balance: 0n, status, acceptUserTransfers,
    expiresAt: status === 'EXPIRED' ? new Date('2026-08-15T10:00:00Z') : null,
    archivedAt: null, archivedByDiscordId: null, createdByDiscordId: String(U),
    createdAt: new Date('2026-08-14T10:00:00Z'), updatedAt: new Date('2026-08-16T10:00:00Z'),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAssertEconomyScopeReady.mockResolvedValue(undefined);
  mockExecuteRaw.mockResolvedValue(1);
});

it('verweigert neue User-Einzahlungen nach Ablauf', async () => {
  mockQueryRaw.mockResolvedValue([account('EXPIRED', true)]);
  await expect(transferUserToVirtualAccount({
    idempotencyKey: 'expired:1', guildId: G, nitradoConnId: C, fromUserId: U,
    virtualAccountId: 'virtual-1', amount: 10n, sourcePocket: 'WALLET',
  })).rejects.toThrow('nicht aktiv');
  expect(mockExecuteRaw.mock.calls.some(([sql]) => String(sql).includes('EconomyVirtualAccountEntry') && String(sql).startsWith('INSERT'))).toBe(false);
});

it('verweigert direkte User-Einzahlungen wenn der Kontotyp sie sperrt', async () => {
  mockQueryRaw.mockResolvedValue([account('ACTIVE', false)]);
  await expect(transferUserToVirtualAccount({
    idempotencyKey: 'closed:1', guildId: G, nitradoConnId: C, fromUserId: U,
    virtualAccountId: 'virtual-1', amount: 10n, sourcePocket: 'BANK',
  })).rejects.toThrow('keine direkten User-Ueberweisungen');
  expect(mockExecuteRaw.mock.calls.some(([sql]) => String(sql).includes('EconomyVirtualAccountEntry') && String(sql).startsWith('INSERT'))).toBe(false);
});
