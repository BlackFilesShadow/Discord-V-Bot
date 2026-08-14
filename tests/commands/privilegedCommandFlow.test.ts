import type { ChatInputCommandInteraction } from 'discord.js';
import type { GuildScope } from '../../src/types/scope';

const scope: GuildScope = {
  guildId: '123456789012345678' as GuildScope['guildId'],
  nitradoConnId: 'c123456789012345678901234' as GuildScope['nitradoConnId'],
  actorDiscordId: '223456789012345678' as GuildScope['actorDiscordId'],
  isOwner: false,
  permissions: new Set(['economy.manage']),
};

const createPendingServerAction = jest.fn();
const consumePendingServerAction = jest.fn();
const adminPay = jest.fn();
const forceLink = jest.fn();
const unlinkUser = jest.fn();

const prismaMock = {
  serverSettings: {
    findUnique: jest.fn(),
  },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/modules/nitrado/pendingServerAction', () => ({
  __esModule: true,
  createPendingServerAction,
  consumePendingServerAction,
}));
jest.mock('../../src/modules/economy/repository', () => ({ __esModule: true, adminPay }));
jest.mock('../../src/modules/linking/linkService', () => ({ __esModule: true, forceLink, unlinkUser }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logAudit: jest.fn(), logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/commands/middleware/withGuildScope', () => ({
  __esModule: true,
  withGuildScope: (_opts: unknown, handler: (interaction: ChatInputCommandInteraction, s: GuildScope) => Promise<void>) =>
    (interaction: ChatInputCommandInteraction) => handler(interaction, scope),
}));

import { addMoneyCommand, confirmActionCommand } from '../../src/commands/dashboard/privileged';

function addInteraction() {
  const reply = jest.fn().mockResolvedValue(undefined);
  const interaction = {
    options: {
      getUser: jest.fn().mockReturnValue({ id: '323456789012345678', bot: false }),
      getInteger: jest.fn().mockReturnValue(250),
      getString: jest.fn().mockReturnValue('Korrektur'),
    },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

function confirmInteraction(id: string) {
  const reply = jest.fn().mockResolvedValue(undefined);
  const interaction = {
    options: {
      getString: jest.fn().mockReturnValue(id),
    },
    reply,
  } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

describe('Phase 8 privileged command confirmation flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.serverSettings.findUnique.mockResolvedValue({ economyActive: true });
  });

  it('/add-money queues a persistent action and performs no economy mutation yet', async () => {
    const actionId = '123e4567-e89b-42d3-a456-426614174000';
    createPendingServerAction.mockResolvedValue({ id: actionId });
    const { interaction, reply } = addInteraction();

    await addMoneyCommand.execute(interaction);

    expect(createPendingServerAction).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        actorDiscordId: scope.actorDiscordId,
        actionType: 'ADD_MONEY',
        payload: {
          targetUserId: '323456789012345678',
          amount: '250',
          reason: 'Korrektur',
        },
      }),
    );
    expect(adminPay).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(actionId) }));
  });

  it('/confirm-action consumes the action once and executes the server-scoped mutation', async () => {
    const actionId = '123e4567-e89b-42d3-a456-426614174000';
    consumePendingServerAction.mockResolvedValue({
      id: actionId,
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      actorDiscordId: scope.actorDiscordId,
      actionType: 'ADD_MONEY',
      payload: { targetUserId: '323456789012345678', amount: '250', reason: 'Korrektur' },
      status: 'CONSUMED',
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: new Date(),
      createdAt: new Date(),
    });
    const { interaction, reply } = confirmInteraction(actionId);

    await confirmActionCommand.execute(interaction);

    expect(consumePendingServerAction).toHaveBeenCalledWith(
      prismaMock,
      expect.objectContaining({ id: actionId, guildId: scope.guildId, actorDiscordId: scope.actorDiscordId }),
    );
    expect(adminPay).toHaveBeenCalledWith({
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      targetUserId: '323456789012345678',
      delta: 250n,
      reason: 'Korrektur',
      actorDiscordId: scope.actorDiscordId,
    });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Guthaben wurde hinzugefuegt.' }));
  });
});
