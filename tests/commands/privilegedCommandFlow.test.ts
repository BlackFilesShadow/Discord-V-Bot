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
const forceLinkByPlayerName = jest.fn();
const unlinkUser = jest.fn();
const applySuccessfulLinkEconomyEffects = jest.fn();
const deactivateLinkRewardState = jest.fn();

const prismaMock = {
  nitradoConnection: { findFirst: jest.fn() },
  serverSettings: { findUnique: jest.fn() },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/modules/nitrado/pendingServerAction', () => ({ __esModule: true, createPendingServerAction, consumePendingServerAction }));
jest.mock('../../src/modules/economy/repository', () => ({ __esModule: true, adminPay }));
jest.mock('../../src/modules/linking/linkService', () => ({ __esModule: true, forceLinkByPlayerName, unlinkUser }));
jest.mock('../../src/modules/linking/linkRewards', () => ({ __esModule: true, applySuccessfulLinkEconomyEffects, deactivateLinkRewardState }));
jest.mock('../../src/utils/logger', () => ({ __esModule: true, logAudit: jest.fn(), logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() } }));
jest.mock('../../src/commands/middleware/withGuildScope', () => ({
  __esModule: true,
  withGuildScope: (_opts: unknown, handler: (interaction: ChatInputCommandInteraction, s: GuildScope) => Promise<void>) =>
    (interaction: ChatInputCommandInteraction) => handler(interaction, scope),
}));

import { addMoneyCommand, removeMoneyCommand, confirmActionCommand } from '../../src/commands/dashboard/privileged';

function moneyInteraction() {
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
  const interaction = { options: { getString: jest.fn().mockReturnValue(id) }, reply } as unknown as ChatInputCommandInteraction;
  return { interaction, reply };
}

function consumedRemoveMoneyAction(actionId: string) {
  return {
    id: actionId,
    guildId: scope.guildId,
    nitradoConnId: scope.nitradoConnId,
    actorDiscordId: scope.actorDiscordId,
    actionType: 'REMOVE_MONEY',
    payload: { targetUserId: '323456789012345678', amount: '250', reason: 'Korrektur' },
    status: 'CONSUMED', expiresAt: new Date(Date.now() + 60_000), consumedAt: new Date(), createdAt: new Date(),
  };
}

describe('privileged economy confirmation flow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.nitradoConnection.findFirst.mockResolvedValue({ slot: 1, status: 'ACTIVE', nitradoServerId: '12345' });
    prismaMock.serverSettings.findUnique.mockResolvedValue({ economyActive: true });
  });

  it('/add-money books immediately and creates no pending confirmation', async () => {
    const { interaction, reply } = moneyInteraction();
    await addMoneyCommand.execute(interaction);
    expect(createPendingServerAction).not.toHaveBeenCalled();
    expect(adminPay).toHaveBeenCalledWith({
      guildId: scope.guildId, nitradoConnId: scope.nitradoConnId,
      targetUserId: '323456789012345678', delta: 250n, reason: 'Korrektur', actorDiscordId: scope.actorDiscordId,
    });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('sofort gutgeschrieben') }));
  });

  it('/remove-money still queues a persistent step-up action', async () => {
    const actionId = '123e4567-e89b-42d3-a456-426614174000';
    createPendingServerAction.mockResolvedValue({ id: actionId });
    const { interaction, reply } = moneyInteraction();
    await removeMoneyCommand.execute(interaction);
    expect(adminPay).not.toHaveBeenCalled();
    expect(createPendingServerAction).toHaveBeenCalledWith(prismaMock, expect.objectContaining({ actionType: 'REMOVE_MONEY' }));
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining(actionId) }));
  });

  it('/confirm-action consumes a deduction once and executes it server-scoped', async () => {
    const actionId = '123e4567-e89b-42d3-a456-426614174000';
    consumePendingServerAction.mockResolvedValue(consumedRemoveMoneyAction(actionId));
    const { interaction, reply } = confirmInteraction(actionId);
    await confirmActionCommand.execute(interaction);
    expect(adminPay).toHaveBeenCalledWith({ guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, targetUserId: '323456789012345678', delta: -250n, reason: 'Korrektur', actorDiscordId: scope.actorDiscordId });
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: 'Guthaben wurde abgezogen.' }));
  });

  it('/confirm-action fails closed when the bound server became inactive', async () => {
    const actionId = '123e4567-e89b-42d3-a456-426614174000';
    consumePendingServerAction.mockResolvedValue(consumedRemoveMoneyAction(actionId));
    prismaMock.nitradoConnection.findFirst.mockResolvedValue({ slot: 1, status: 'REVOKED', nitradoServerId: '12345' });
    const { interaction, reply } = confirmInteraction(actionId);
    await confirmActionCommand.execute(interaction);
    expect(adminPay).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ content: expect.stringContaining('nicht mehr aktiv') }));
  });
});
