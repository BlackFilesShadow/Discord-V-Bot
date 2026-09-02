import { ChannelType } from 'discord.js';

const prismaFindUnique = jest.fn();
const prismaUpdate = jest.fn();
const prismaFindMany = jest.fn();
const getWhitelist = jest.fn();
const getBanlist = jest.fn();
const decryptMock = jest.fn(() => 'plain-token');

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    serverSettings: {
      findUnique: prismaFindUnique,
      update: prismaUpdate,
      findMany: prismaFindMany,
    },
  },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: 'test-key' } },
}));

jest.mock('../../src/utils/security', () => ({
  decrypt: decryptMock,
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({
    getWhitelist,
    getBanlist,
  })),
}));

import {
  handleServerListCatalogButton,
  handleServerListCatalogSearch,
  stopServerListCatalogSync,
  syncServerListCatalog,
} from '../../src/modules/nitrado/serverListCatalog';
import { NitradoClient } from '../../src/modules/nitrado/nitradoClient';

const guildId = 'guild-1';
const connId = 'conn-1';
const channelId = 'channel-1';
const messageId = 'message-1';
const botId = 'bot-1';

const names = Array.from({ length: 45 }, (_, index) => `player-${String(index + 1).padStart(3, '0')}`);
const row = {
  guildId,
  nitradoConnId: connId,
  whitelistCatalogChannelId: null,
  whitelistCatalogMessageId: null,
  banCatalogChannelId: channelId,
  banCatalogMessageId: messageId,
  nitradoConn: {
    encryptedToken: 'encrypted-token',
    nitradoServerId: 'nitrado-server-1',
    status: 'ACTIVE',
  },
};

function discordFixture() {
  const messageEdit = jest.fn().mockResolvedValue(undefined);
  const managedMessage = { id: messageId, edit: messageEdit };
  const messageFetch = jest.fn().mockResolvedValue(managedMessage);
  const channel = { id: channelId, type: ChannelType.GuildText, messages: { fetch: messageFetch } };
  const channelFetch = jest.fn().mockResolvedValue(channel);
  const client = {
    user: { id: botId },
    guilds: { cache: new Map([[guildId, { channels: { fetch: channelFetch } }]]) },
  };
  return { client, channelFetch, messageFetch, messageEdit };
}

async function seedWarmBanCatalog() {
  const discord = discordFixture();
  prismaFindUnique.mockResolvedValue(row);
  prismaUpdate.mockResolvedValue(row);
  getBanlist.mockResolvedValue(names.map(identifier => ({ identifier })));
  getWhitelist.mockResolvedValue([]);
  await syncServerListCatalog(discord.client as never, guildId, connId, 'ban');
  return discord;
}

function clearIoCounters(discord: ReturnType<typeof discordFixture>) {
  prismaFindUnique.mockClear();
  prismaUpdate.mockClear();
  prismaFindMany.mockClear();
  getWhitelist.mockClear();
  getBanlist.mockClear();
  decryptMock.mockClear();
  (NitradoClient as unknown as jest.Mock).mockClear();
  discord.channelFetch.mockClear();
  discord.messageFetch.mockClear();
  discord.messageEdit.mockClear();
}

function expectNoExternalRead(discord: ReturnType<typeof discordFixture>) {
  expect(prismaFindUnique).not.toHaveBeenCalled();
  expect(prismaUpdate).not.toHaveBeenCalled();
  expect(prismaFindMany).not.toHaveBeenCalled();
  expect(getWhitelist).not.toHaveBeenCalled();
  expect(getBanlist).not.toHaveBeenCalled();
  expect(decryptMock).not.toHaveBeenCalled();
  expect(NitradoClient).not.toHaveBeenCalled();
  expect(discord.channelFetch).not.toHaveBeenCalled();
  expect(discord.messageFetch).not.toHaveBeenCalled();
  expect(discord.messageEdit).not.toHaveBeenCalled();
}

afterEach(() => {
  stopServerListCatalogSync();
  jest.clearAllMocks();
});

test('warm ban catalog page navigation performs zero external reads and updates immediately', async () => {
  const discord = await seedWarmBanCatalog();
  clearIoCounters(discord);
  const update = jest.fn().mockResolvedValue(undefined);
  const reply = jest.fn().mockResolvedValue(undefined);
  const followUp = jest.fn().mockResolvedValue(undefined);
  const interaction = {
    customId: `listcat:ban:${connId}:1`,
    guildId,
    channelId,
    user: { id: 'user-1' },
    client: { user: { id: botId } },
    message: { id: messageId, author: { id: botId } },
    deferred: false,
    replied: false,
    update,
    reply,
    followUp,
  };

  await handleServerListCatalogButton(interaction as never);

  expect(update).toHaveBeenCalledTimes(1);
  expect(reply).not.toHaveBeenCalled();
  expect(followUp).not.toHaveBeenCalled();
  const payload = update.mock.calls[0][0];
  const embed = payload.embeds[0].toJSON();
  expect(embed.description).toContain('player-021');
  expect(embed.description).toContain('player-040');
  expect(embed.description).not.toContain('player-020');
  expect(embed.footer?.text).toContain('Seite 2/3');
  expectNoExternalRead(discord);
});

test('catalog search is snapshot-only, ephemeral and ranks exact matches first', async () => {
  const discord = await seedWarmBanCatalog();
  clearIoCounters(discord);
  const deferReply = jest.fn().mockResolvedValue(undefined);
  const editReply = jest.fn().mockResolvedValue(undefined);
  const interaction = {
    customId: `listcat_search:ban:${connId}:${messageId}`,
    guildId,
    channelId,
    user: { id: 'user-2' },
    fields: { getTextInputValue: jest.fn(() => 'PLAYER-021') },
    deferReply,
    editReply,
  };

  await handleServerListCatalogSearch(interaction as never);

  expect(deferReply).toHaveBeenCalledWith(expect.objectContaining({ flags: expect.anything() }));
  expect(editReply).toHaveBeenCalledTimes(1);
  const payload = editReply.mock.calls[0][0];
  const embed = payload.embeds[0].toJSON();
  expect(embed.description).toContain('player-021');
  expect(embed.footer?.text).toContain('1 Einträge');
  expect(embed.footer?.text).toContain('Suche: PLAYER-021');
  expectNoExternalRead(discord);
});
