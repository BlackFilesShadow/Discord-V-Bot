import type { ChatInputCommandInteraction } from 'discord.js';
import type { GuildScope } from '../../src/types/scope';

const TEST_GUILD_ID = '123456789' + '012345678';
const TEST_ACTOR_ID = '223456789' + '012345678';

const scope: GuildScope = {
  guildId: TEST_GUILD_ID as GuildScope['guildId'],
  nitradoConnId: 'c123456789012345678901234' as GuildScope['nitradoConnId'],
  actorDiscordId: TEST_ACTOR_ID as GuildScope['actorDiscordId'],
  isOwner: false,
  permissions: new Set(),
};

const getAccountOrZero = jest.fn();
const deposit = jest.fn().mockResolvedValue(undefined);
const withdraw = jest.fn().mockResolvedValue(undefined);
const getConfig = jest.fn().mockResolvedValue({ emoji: '🐭' });

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findFirst: jest.fn().mockResolvedValue({ alias: 'Test Server' }) },
  },
}));

jest.mock('../../src/modules/economy/repository', () => ({
  __esModule: true,
  getAccountOrZero,
  deposit,
  withdraw,
  getConfig,
  pay: jest.fn(),
  adminPay: jest.fn(),
  transferBank: jest.fn(),
}));

jest.mock('../../src/modules/nitrado/pendingServerAction', () => ({
  __esModule: true,
  createPendingServerAction: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logAudit: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/commands/middleware/withGuildScope', () => ({
  __esModule: true,
  withGuildScope: (_opts: unknown, handler: (interaction: ChatInputCommandInteraction, s: GuildScope) => Promise<void>) =>
    (interaction: ChatInputCommandInteraction) => handler(interaction, scope),
}));

import { depositCommand, withdrawCommand } from '../../src/commands/dashboard/economy';

function interactionWithoutAmount(): ChatInputCommandInteraction {
  return {
    options: {
      getInteger: jest.fn().mockReturnValue(null),
    },
    reply: jest.fn().mockResolvedValue(undefined),
  } as unknown as ChatInputCommandInteraction;
}

describe('economy full-balance transfer fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getConfig.mockResolvedValue({ emoji: '🐭' });
  });

  it('/deposit without betrag moves the complete current wallet balance', async () => {
    getAccountOrZero
      .mockResolvedValueOnce({ walletBalance: 125n, bankBalance: 25n })
      .mockResolvedValueOnce({ walletBalance: 0n, bankBalance: 150n });

    await depositCommand.execute(interactionWithoutAmount());

    expect(deposit).toHaveBeenCalledWith(scope.guildId, scope.nitradoConnId, scope.actorDiscordId, 125n);
  });

  it('/withdraw without betrag moves the complete current bank balance', async () => {
    getAccountOrZero
      .mockResolvedValueOnce({ walletBalance: 25n, bankBalance: 125n })
      .mockResolvedValueOnce({ walletBalance: 150n, bankBalance: 0n });

    await withdrawCommand.execute(interactionWithoutAmount());

    expect(withdraw).toHaveBeenCalledWith(scope.guildId, scope.nitradoConnId, scope.actorDiscordId, 125n);
  });

  it('does not attempt a zero-value full transfer', async () => {
    getAccountOrZero.mockResolvedValueOnce({ walletBalance: 0n, bankBalance: 50n });
    const interaction = interactionWithoutAmount();

    await depositCommand.execute(interaction);

    expect(deposit).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalled();
  });
});
