import type { ChatInputCommandInteraction } from 'discord.js';
import type { GuildScope } from '../../src/types/scope';

const scope: GuildScope = {
  guildId: '123456789012345678' as GuildScope['guildId'],
  nitradoConnId: 'c123456789012345678901234' as GuildScope['nitradoConnId'],
  actorDiscordId: '223456789012345678' as GuildScope['actorDiscordId'],
  isOwner: false,
  permissions: new Set(['whitelist.manage']),
};

const enqueueWhitelistRemove = jest.fn();
const logAudit = jest.fn();
const emitGuildEvent = jest.fn();
const resolveSelectedOrAllServers = jest.fn();

let entryUpdateCount = 0;
const txMock = {
  whitelistEntry: { updateMany: jest.fn(async () => ({ count: entryUpdateCount })) },
  whitelistRequest: { updateMany: jest.fn(async () => ({ count: 0 })) },
};
const prismaMock = {
  $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)),
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/modules/whitelist/whitelistOutbox', () => ({
  __esModule: true,
  enqueueWhitelistAdd: jest.fn(),
  enqueueWhitelistRemove: (...args: unknown[]) => enqueueWhitelistRemove(...args),
}));
jest.mock('../../src/modules/whitelist/whitelistRequestPreflight', () => ({
  __esModule: true,
  isAlreadyOnRemoteWhitelist: jest.fn(async () => false),
}));
jest.mock('../../src/modules/whitelist/whitelistRequestClaim', () => ({
  __esModule: true,
  claimWhitelistRequest: jest.fn(),
}));
jest.mock('../../src/modules/bans/whitelistBanGuard', () => ({
  __esModule: true,
  ACTIVE_BAN_WHITELIST_WARNING: 'Server-Bann aktiv.',
  isWhitelistBlockedByActiveServerBan: jest.fn(async () => false),
}));
jest.mock('../../src/dashboard/socket/emitter', () => ({
  __esModule: true,
  emitGuildEvent: (...args: unknown[]) => emitGuildEvent(...args),
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logAudit: (...args: unknown[]) => logAudit(...args),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));
jest.mock('../../src/commands/dashboard/serverTargetSelection', () => ({
  __esModule: true,
  autocompleteServerAlias: jest.fn(),
  resolveSelectedOrAllServers: (...args: unknown[]) => resolveSelectedOrAllServers(...args),
  resolveSingleServer: jest.fn(),
  targetLabel: (t: { alias: string }) => t.alias,
}));
jest.mock('../../src/commands/middleware/withGuildScope', () => ({
  __esModule: true,
  withGuildScope: (
    _opts: unknown,
    handler: (interaction: ChatInputCommandInteraction, s: GuildScope) => Promise<void>,
  ) => (interaction: ChatInputCommandInteraction) => handler(interaction, scope),
}));

import { wlRemoveCommand } from '../../src/commands/dashboard/whitelist';

function removeInteraction(id = 'PlayerOne') {
  const reply = jest.fn().mockResolvedValue(undefined);
  const interaction = {
    options: { getString: jest.fn((name: string) => (name === 'id' ? id : null)) },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

describe('/whitelist-remove (intern wl-remove) meldet den Ausgang ehrlich', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resolveSelectedOrAllServers.mockResolvedValue([{ id: 'conn-1', slot: 1, alias: 'Chernarus', status: 'ACTIVE' }]);
  });

  it('meldet eine einfache Entfernung, wenn eine lokale Whitelist-Zeile existiert', async () => {
    entryUpdateCount = 1;
    const { interaction, reply } = removeInteraction();
    await wlRemoveCommand.execute(interaction);

    expect(enqueueWhitelistRemove).toHaveBeenCalledTimes(1);
    const description = (reply.mock.calls[0][0] as { embeds: Array<{ data: { description?: string } }> }).embeds[0].data.description;
    expect(description).toContain('wurde von der Whitelist entfernt');
    expect(description).not.toContain('Sync');
    expect(description).not.toContain('lokaler Eintrag');
    expect(logAudit).toHaveBeenCalledWith('WL_REMOVE', 'WHITELIST', expect.objectContaining({ hadLocalEntry: true }));
  });

  it('behauptet KEINEN Erfolg, wenn kein lokaler Eintrag existiert (UNTRACKED-Remove ist serverseitig fail-closed gesperrt)', async () => {
    entryUpdateCount = 0;
    const { interaction, reply } = removeInteraction();
    await wlRemoveCommand.execute(interaction);

    expect(enqueueWhitelistRemove).toHaveBeenCalledTimes(1);
    const description = (reply.mock.calls[0][0] as { embeds: Array<{ data: { description?: string } }> }).embeds[0].data.description;
    expect(description).toContain('nicht eindeutig in der Whitelist gefunden');
    expect(description).not.toContain('Sync');
    expect(description).not.toContain('lokaler Eintrag');
    expect(logAudit).toHaveBeenCalledWith('WL_REMOVE', 'WHITELIST', expect.objectContaining({ hadLocalEntry: false }));
  });
});
