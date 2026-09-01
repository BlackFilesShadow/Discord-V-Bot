const queryRawMock = jest.fn();
const listMarketListingsMock = jest.fn();
const getConfigMock = jest.fn();
const getVirtualAccountByIdMock = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    $queryRawUnsafe: (...args: unknown[]) => queryRawMock(...args),
    economyMarketListing: { findFirst: jest.fn(), findMany: jest.fn() },
    economyMarketDiscordProjection: { findUnique: jest.fn() },
  },
}));

jest.mock('../../src/modules/economy/blackMarket', () => ({
  __esModule: true,
  listMarketListings: (...args: unknown[]) => listMarketListingsMock(...args),
}));

jest.mock('../../src/modules/economy/repository', () => ({
  __esModule: true,
  getConfig: (...args: unknown[]) => getConfigMock(...args),
}));

jest.mock('../../src/modules/economy/virtualAccounts', () => ({
  __esModule: true,
  getVirtualAccountById: (...args: unknown[]) => getVirtualAccountByIdMock(...args),
}));

jest.mock('../../src/modules/economy/blackMarketOrder', () => ({
  __esModule: true,
  attachMarketOrderMessage: jest.fn(),
  closeMarketOrder: jest.fn(),
  listOpenMarketOrders: jest.fn(),
}));

jest.mock('../../src/modules/economy/blackMarketOrderV2', () => ({
  __esModule: true,
  createMarketOrderV2: jest.fn(),
  MAX_MARKET_ORDER_UNITS: 20,
  scheduleMarketOrderReadyNoticeOneHour: jest.fn(),
}));

jest.mock('../../src/modules/economy/virtualAccountFinance', () => ({
  __esModule: true,
  listManagedVirtualAccounts: jest.fn(),
}));

import { handleMarketOrderButton } from '../../src/modules/economy/blackMarketOrderInteractionsV2';

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const MESSAGE = '323456789012345678';
const BOT = '423456789012345678';
const USER = '523456789012345678';
const CONN = 'conn-1';
const VENDOR_A = 'vendor-a';
const VENDOR_B = 'vendor-b';
const CATALOG_PROJECTION = '0123456789abcdef0123456789abcdef';

function listing(id: string, vendorAccountId: string, name: string) {
  return {
    id,
    vendorAccountId,
    sku: id.toUpperCase(),
    name,
    description: null,
    price: 100n,
    deliveryItems: [{ itemText: name, quantity: 1 }],
    active: true,
    archivedAt: null,
    createdAt: new Date('2026-09-01T20:00:00Z'),
    updatedAt: new Date('2026-09-01T20:00:00Z'),
  };
}

function interaction(overrides: Record<string, unknown> = {}) {
  const reply = jest.fn().mockResolvedValue(undefined);
  const base = {
    customId: `marketorder:open:v1:${CATALOG_PROJECTION}`,
    guildId: GUILD,
    channelId: CHANNEL,
    user: { id: USER },
    client: { user: { id: BOT } },
    message: { id: MESSAGE, author: { id: BOT } },
    replied: false,
    deferred: false,
    reply,
    followUp: jest.fn().mockResolvedValue(undefined),
  };
  return { value: { ...base, ...overrides } as never, reply };
}

beforeEach(() => {
  jest.clearAllMocks();
  queryRawMock.mockResolvedValue([{ guildId: GUILD, nitradoConnId: CONN, vendorAccountId: VENDOR_A }]);
  getVirtualAccountByIdMock.mockResolvedValue({ id: VENDOR_A, name: 'Vendor A', kind: 'MARKET_VENDOR', status: 'ACTIVE' });
  getConfigMock.mockResolvedValue({ currencyName: 'Mäuse', emoji: '🐭' });
  listMarketListingsMock.mockResolvedValue([
    listing('listing-a', VENDOR_A, 'Artikel A'),
    listing('listing-b', VENDOR_B, 'Artikel B'),
  ]);
});

test('real order handler resolves a valid vendor anchor server-side and exposes only that vendor listings', async () => {
  const { value, reply } = interaction();

  await handleMarketOrderButton(value);

  expect(queryRawMock).toHaveBeenCalledTimes(1);
  expect(queryRawMock.mock.calls[0].slice(1)).toEqual([CATALOG_PROJECTION, GUILD, CHANNEL, MESSAGE]);
  expect(getVirtualAccountByIdMock).toHaveBeenCalledWith(GUILD, CONN, VENDOR_A);
  expect(reply).toHaveBeenCalledTimes(1);

  const payload = reply.mock.calls[0][0];
  const rendered = JSON.stringify(payload.components.map((row: { toJSON: () => unknown }) => row.toJSON()));
  expect(rendered).toContain('listing-a');
  expect(rendered).not.toContain('listing-b');
});

test('real order handler rejects malformed vendor anchor before any database lookup', async () => {
  const { value, reply } = interaction({ customId: 'marketorder:open:v1:bad:id' });

  await handleMarketOrderButton(value);

  expect(queryRawMock).not.toHaveBeenCalled();
  expect(listMarketListingsMock).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply.mock.calls[0][0].embeds[0].data.title).toBe('Bestellung abgelehnt');
});

test('real order handler rejects a copied anchor in a foreign guild/channel/message scope', async () => {
  queryRawMock.mockResolvedValueOnce([]);
  const { value, reply } = interaction({ guildId: '623456789012345678' });

  await handleMarketOrderButton(value);

  expect(queryRawMock).toHaveBeenCalledTimes(1);
  expect(queryRawMock.mock.calls[0].slice(1)).toEqual([
    CATALOG_PROJECTION,
    '623456789012345678',
    CHANNEL,
    MESSAGE,
  ]);
  expect(listMarketListingsMock).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
});

test('real order handler rejects a message not authored by the current V-Bot', async () => {
  const { value, reply } = interaction({ message: { id: MESSAGE, author: { id: '723456789012345678' } } });

  await handleMarketOrderButton(value);

  expect(queryRawMock).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
});

test('real order handler fails closed when persisted vendor becomes inactive', async () => {
  getVirtualAccountByIdMock.mockResolvedValueOnce({ id: VENDOR_A, name: 'Vendor A', kind: 'MARKET_VENDOR', status: 'ARCHIVED' });
  const { value, reply } = interaction();

  await handleMarketOrderButton(value);

  expect(queryRawMock).toHaveBeenCalledTimes(1);
  expect(reply).toHaveBeenCalledTimes(1);
  expect(reply.mock.calls[0][0].embeds[0].data.description).toContain('nicht mehr aktiv');
});
