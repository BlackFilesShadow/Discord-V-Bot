jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    economyMarketVendorCatalogProjection: {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    economyMarketDiscordProjection: {
      findFirst: jest.fn(),
    },
    economyVirtualAccount: {
      findFirst: jest.fn(),
    },
  },
}));

jest.mock('../../src/modules/economy/blackMarket', () => ({
  __esModule: true,
  listMarketListings: jest.fn(),
}));

jest.mock('../../src/modules/economy/repository', () => ({
  __esModule: true,
  getConfig: jest.fn(),
}));

import prisma from '../../src/database/prisma';
import { listMarketListings } from '../../src/modules/economy/blackMarket';
import { handleMarketVendorCatalogPageButton } from '../../src/modules/economy/blackMarketDiscord';
import { getConfig } from '../../src/modules/economy/repository';

const vendorCatalogFindUniqueMock = prisma.economyMarketVendorCatalogProjection.findUnique as unknown as jest.Mock;
const vendorCatalogUpdateManyMock = prisma.economyMarketVendorCatalogProjection.updateMany as unknown as jest.Mock;
const marketProjectionFindFirstMock = prisma.economyMarketDiscordProjection.findFirst as unknown as jest.Mock;
const virtualAccountFindFirstMock = prisma.economyVirtualAccount.findFirst as unknown as jest.Mock;
const listMarketListingsMock = listMarketListings as unknown as jest.Mock;
const getConfigMock = getConfig as unknown as jest.Mock;

const GUILD = '123456789012345678';
const CHANNEL = '223456789012345678';
const MESSAGE = '323456789012345678';
const BOT = '423456789012345678';
const USER = '523456789012345678';
const CONN = 'conn-1';
const VENDOR_A = 'vendor-a';
const VENDOR_B = 'vendor-b';
const PROJECTION = 'market-projection-1';
const CATALOG = '0123456789abcdef0123456789abcdef';

const persistedCatalog = {
  id: CATALOG,
  projectionId: PROJECTION,
  guildId: GUILD,
  nitradoConnId: CONN,
  vendorAccountId: VENDOR_A,
  channelId: CHANNEL,
  catalogMessageId: MESSAGE,
  orderButtonMessageId: '623456789012345678',
  currentPage: 0,
};

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

function interaction(customId = `marketcat:v1:page:${CATALOG}:1`, overrides: Record<string, unknown> = {}) {
  const edit = jest.fn().mockResolvedValue(undefined);
  const reply = jest.fn().mockResolvedValue(undefined);
  const followUp = jest.fn().mockResolvedValue(undefined);
  const state: Record<string, unknown> = {
    customId,
    guildId: GUILD,
    channelId: CHANNEL,
    user: { id: USER },
    client: { user: { id: BOT } },
    message: { id: MESSAGE, author: { id: BOT }, edit },
    replied: false,
    deferred: false,
    reply,
    followUp,
  };
  const deferUpdate = jest.fn().mockImplementation(async () => {
    state.deferred = true;
  });
  state.deferUpdate = deferUpdate;
  Object.assign(state, overrides);
  return { value: state as never, edit, reply, followUp, deferUpdate };
}

beforeEach(() => {
  jest.clearAllMocks();
  vendorCatalogFindUniqueMock.mockResolvedValue(persistedCatalog);
  vendorCatalogUpdateManyMock.mockResolvedValue({ count: 1 });
  marketProjectionFindFirstMock.mockResolvedValue({ id: PROJECTION, catalogChannelId: CHANNEL });
  virtualAccountFindFirstMock.mockResolvedValue({ id: VENDOR_A, name: 'Vendor A' });
  getConfigMock.mockResolvedValue({ currencyName: 'Mäuse', emoji: '🐭' });
  listMarketListingsMock.mockResolvedValue([
    listing('a-1', VENDOR_A, 'A 1'),
    listing('a-2', VENDOR_A, 'A 2'),
    listing('a-3', VENDOR_A, 'A 3'),
    listing('a-4', VENDOR_A, 'A 4'),
    listing('a-5', VENDOR_A, 'A 5'),
    listing('a-6', VENDOR_A, 'A 6'),
    listing('b-1', VENDOR_B, 'B 1'),
  ]);
});

test('real catalog handler renders only the persisted vendor page and saves that page', async () => {
  const { value, edit, deferUpdate } = interaction();

  await handleMarketVendorCatalogPageButton(value);

  expect(deferUpdate).toHaveBeenCalledTimes(1);
  expect(vendorCatalogFindUniqueMock).toHaveBeenCalledTimes(2);
  expect(edit).toHaveBeenCalledTimes(1);
  const rendered = JSON.stringify(edit.mock.calls[0][0]);
  expect(rendered).toContain('A 6');
  expect(rendered).not.toContain('B 1');
  expect(vendorCatalogUpdateManyMock).toHaveBeenCalledWith(expect.objectContaining({ data: { currentPage: 1 } }));
});

test('real catalog handler rejects a page that does not exist', async () => {
  const { value, edit, followUp } = interaction(`marketcat:v1:page:${CATALOG}:2`);

  await handleMarketVendorCatalogPageButton(value);

  expect(edit).not.toHaveBeenCalled();
  expect(vendorCatalogUpdateManyMock).not.toHaveBeenCalled();
  expect(followUp).toHaveBeenCalledTimes(1);
  expect(followUp.mock.calls[0][0].content).toContain('existiert nicht');
});

test('real catalog handler rejects copied catalog message scope before rendering', async () => {
  const foreignEdit = jest.fn();
  const { value, followUp } = interaction(undefined, {
    message: { id: '723456789012345678', author: { id: BOT }, edit: foreignEdit },
  });

  await handleMarketVendorCatalogPageButton(value);

  expect(foreignEdit).not.toHaveBeenCalled();
  expect(marketProjectionFindFirstMock).not.toHaveBeenCalled();
  expect(followUp).toHaveBeenCalledTimes(1);
});

test('real catalog handler rejects malformed page IDs before database access', async () => {
  const { value, deferUpdate, reply } = interaction(`marketcat:v1:page:${CATALOG}:01`);

  await handleMarketVendorCatalogPageButton(value);

  expect(deferUpdate).not.toHaveBeenCalled();
  expect(vendorCatalogFindUniqueMock).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
});

test('real catalog handler rejects messages not authored by the current V-Bot', async () => {
  const foreignEdit = jest.fn();
  const { value, deferUpdate, reply } = interaction(undefined, {
    message: { id: MESSAGE, author: { id: '823456789012345678' }, edit: foreignEdit },
  });

  await handleMarketVendorCatalogPageButton(value);

  expect(deferUpdate).not.toHaveBeenCalled();
  expect(vendorCatalogFindUniqueMock).not.toHaveBeenCalled();
  expect(reply).toHaveBeenCalledTimes(1);
});
