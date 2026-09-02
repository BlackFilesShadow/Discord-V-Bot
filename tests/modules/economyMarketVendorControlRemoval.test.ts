import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../src/types/scope';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: jest.fn(),
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/modules/economy/scopeMigration', () => ({
  assertEconomyScopeReady: jest.fn().mockResolvedValue(undefined),
}));

import prisma from '../../src/database/prisma';
import {
  listHiddenMarketVendorIds,
  removeMarketVendorFromControl,
} from '../../src/modules/economy/blackMarketVendorDeletion';

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

const GUILD = '123456789012345678' as GuildId;
const CONN = 'c123456789012345678901234' as NitradoConnId;
const ACTOR = '223456789012345678' as UserDiscordId;
const VENDOR = 'vendor-1';

type State = {
  exists: boolean;
  kind: string;
  status: string;
  balance: bigint;
  hidden: boolean;
  activeListings: bigint;
  openOrders: bigint;
  pendingFulfillments: bigint;
  bankBalance: bigint;
};

type RawMock = {
  $queryRawUnsafe: jest.Mock;
  $executeRawUnsafe: jest.Mock;
};

const db = prisma as unknown as {
  $queryRawUnsafe: jest.Mock;
  $transaction: jest.Mock;
};

let state: State;
let raw: RawMock;

function queryResult(sql: string) {
  if (sql.includes('FROM "EconomyVirtualAccount"')) {
    return state.exists ? [{ id: VENDOR, name: 'Nachtmarkt', kind: state.kind, status: state.status, balance: state.balance }] : [];
  }
  if (sql.includes('FROM "EconomyMarketVendorControlHidden"')) {
    return state.hidden ? [{ vendorAccountId: VENDOR }] : [];
  }
  if (sql.includes('FROM "EconomyMarketListing"')) return [{ count: state.activeListings }];
  if (sql.includes('FROM "EconomyMarketOrder"')) return [{ count: state.openOrders }];
  if (sql.includes('EconomyMarketPurchaseFulfillment')) return [{ count: state.pendingFulfillments }];
  if (sql.includes('FROM "EconomyVirtualAccountFinance"')) return [{ bankBalance: state.bankBalance }];
  throw new Error(`Unerwartete Test-Query: ${sql}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  state = {
    exists: true,
    kind: 'MARKET_VENDOR',
    status: 'ACTIVE',
    balance: 0n,
    hidden: false,
    activeListings: 0n,
    openOrders: 0n,
    pendingFulfillments: 0n,
    bankBalance: 0n,
  };
  raw = {
    $queryRawUnsafe: jest.fn(async (sql: string) => queryResult(sql)),
    $executeRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.startsWith('UPDATE "EconomyVirtualAccount"')) return 1;
      if (sql.startsWith('INSERT INTO "EconomyMarketVendorControlHidden"')) return 1;
      throw new Error(`Unerwartetes Test-Statement: ${sql}`);
    }),
  };
  db.$transaction.mockImplementation(async (callback: (client: RawMock) => unknown) => callback(raw));
  db.$queryRawUnsafe.mockImplementation(async (sql: string) => queryResult(sql));
});

const blockedCases: Array<[string, () => void, string]> = [
  ['inaktiver Status', () => { state.status = 'ARCHIVED'; }, 'Nur aktive Haendler'],
  ['aktive Angebote', () => { state.activeListings = 1n; }, 'aktive Angebote'],
  ['offene Sammelbestellungen', () => { state.openOrders = 1n; }, 'offene Sammelbestellungen'],
  ['offene Fulfillments', () => { state.pendingFulfillments = 1n; }, 'offene Bestellungen'],
  ['Wallet-Guthaben', () => { state.balance = 1n; }, 'Wallet oder Bank'],
  ['Bank-Guthaben', () => { state.bankBalance = 1n; }, 'Wallet oder Bank'],
];

describe('safe market vendor removal', () => {
  test('archiviert und versteckt einen leeren aktiven Haendler atomar', async () => {
    const result = await removeMarketVendorFromControl({
      guildId: GUILD,
      nitradoConnId: CONN,
      vendorAccountId: VENDOR,
      actorDiscordId: ACTOR,
    });

    expect(result).toEqual({ id: VENDOR, name: 'Nachtmarkt', mode: 'CONTROL_HIDDEN', changed: true });
    expect(raw.$queryRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE'))).toBe(true);
    expect(raw.$queryRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('"status"=\'OPEN\''))).toBe(true);
    expect(raw.$queryRawUnsafe.mock.calls.some(([sql]) => String(sql).includes('f."status"=\'PENDING\''))).toBe(true);
    expect(raw.$executeRawUnsafe.mock.calls[0][0]).toContain("\"status\"='ARCHIVED'");
    expect(raw.$executeRawUnsafe.mock.calls[1][0]).toContain('INSERT INTO "EconomyMarketVendorControlHidden"');
  });

  test('zweiter Delete ist idempotent und schreibt nichts erneut', async () => {
    state.status = 'ARCHIVED';
    state.hidden = true;

    const result = await removeMarketVendorFromControl({
      guildId: GUILD,
      nitradoConnId: CONN,
      vendorAccountId: VENDOR,
      actorDiscordId: ACTOR,
    });

    expect(result.changed).toBe(false);
    expect(raw.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('fremder Scope bzw. fehlender Haendler wird fail-closed abgelehnt', async () => {
    state.exists = false;
    await expect(removeMarketVendorFromControl({
      guildId: GUILD,
      nitradoConnId: CONN,
      vendorAccountId: VENDOR,
      actorDiscordId: ACTOR,
    })).rejects.toThrow('MARKET_VENDOR-Systemkonto nicht gefunden.');
  });

  test.each(blockedCases)('blockiert %s', async (_label, mutate, message) => {
    mutate();
    await expect(removeMarketVendorFromControl({
      guildId: GUILD,
      nitradoConnId: CONN,
      vendorAccountId: VENDOR,
      actorDiscordId: ACTOR,
    })).rejects.toThrow(message);
    expect(raw.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('listHiddenMarketVendorIds ist strikt Guild+Connection-gescoppt', async () => {
    state.hidden = true;
    const result = await listHiddenMarketVendorIds({ guildId: GUILD, nitradoConnId: CONN });
    expect(result).toEqual(new Set([VENDOR]));
    expect(db.$queryRawUnsafe).toHaveBeenCalledWith(
      expect.stringContaining('WHERE "guildId"=$1 AND "nitradoConnId"=$2'),
      String(GUILD),
      String(CONN),
    );
  });
});

describe('phase 3 contract', () => {
  test('Migration ist additiv, gescoppt und historienerhaltend', () => {
    const migration = read('prisma/migrations/20260902030000_economy_market_vendor_control_hidden/migration.sql');
    const model = read('prisma/economy_market_vendor_control.prisma');
    expect(migration).toContain('CREATE TABLE "EconomyMarketVendorControlHidden"');
    expect(migration).toContain('FOREIGN KEY ("vendorAccountId", "guildId", "nitradoConnId")');
    expect(migration).toContain('REFERENCES "EconomyVirtualAccount"("id", "guildId", "nitradoConnId")');
    expect(model).toContain('model EconomyMarketVendorControlHidden');
    expect(migration).not.toContain('DELETE FROM "EconomyVirtualAccount"');
    expect(migration).not.toContain('DELETE FROM "EconomyMarketPurchase"');
    expect(migration).not.toContain('DELETE FROM "EconomyMarketOrder"');
  });

  test('Service prueft alle Safe-Delete-Gates und loescht keine Fachhistorie', () => {
    const service = read('src/modules/economy/blackMarketVendorDeletion.ts');
    expect(service).toContain('FOR UPDATE');
    expect(service).toContain("vendor.status !== 'ACTIVE'");
    expect(service).toContain('EconomyMarketListing');
    expect(service).toContain('EconomyMarketOrder');
    expect(service).toContain('EconomyMarketOrderStatus');
    expect(service).toContain('OPEN');
    expect(service).toContain('EconomyMarketPurchaseFulfillment');
    expect(service).toContain('PENDING');
    expect(service).toContain('EconomyVirtualAccountFinance');
    expect(service).toContain('vendor.balance !== 0n');
    expect(service).toContain('EconomyMarketVendorControlHidden');
    expect(service).not.toContain('DELETE FROM "EconomyVirtualAccount"');
    expect(service).not.toContain('DELETE FROM "EconomyMarketPurchase"');
    expect(service).not.toContain('DELETE FROM "EconomyMarketOrder"');
  });

  test('Dashboard-Route und UI trennen Archivieren und Entfernen', () => {
    const route = read('src/dashboard/routes/v2/economyBlackMarket.ts');
    const ui = read('dashboard-ui/src/components/economy/BlackMarketPanel.tsx');
    expect(route).toContain("delete('/vendors/:vendorId'");
    expect(route).toContain('listHiddenMarketVendorIds');
    expect(route).toContain('removeMarketVendorFromControl');
    expect(route).toContain('MARKET_VENDOR_REMOVED');
    expect(ui).toContain('const removeVendor = useMutation');
    expect(ui).toContain('/economy/black-market/vendors/${id}?${scope}');
    expect(ui).toContain('Haendler ${vendor.name} entfernen');
    expect(ui).toContain("vendor.status === 'ACTIVE'");
  });
});