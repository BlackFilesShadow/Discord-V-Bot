var mockFindRequest: jest.Mock;
var mockTransaction: jest.Mock;
var mockBlockedByBan: jest.Mock;

jest.mock('../../src/database/prisma', () => {
  mockFindRequest = jest.fn();
  mockTransaction = jest.fn();
  return {
    __esModule: true,
    default: {
      whitelistRequest: { findUnique: mockFindRequest },
      $transaction: mockTransaction,
    },
  };
});

jest.mock('../../src/modules/bans/whitelistBanGuard', () => {
  mockBlockedByBan = jest.fn();
  return {
    ACTIVE_BAN_WHITELIST_WARNING:
      '⚠️ Dieser Spieler steht auf diesem Gameserver auf der aktiven Bannliste. Die Whitelist-Freigabe wurde nicht durchgeführt.',
    isWhitelistBlockedByActiveServerBan: mockBlockedByBan,
  };
});

jest.mock('../../src/modules/permissions/access', () => ({
  resolveDelegatedPermissionContext: jest.fn(),
}));
jest.mock('../../src/modules/whitelist/whitelistChannels', () => ({
  notifyRequesterDecision: jest.fn(),
  postDecisionLog: jest.fn(),
}));
jest.mock('../../src/modules/whitelist/whitelistOutbox', () => ({
  enqueueWhitelistAdd: jest.fn(),
}));
jest.mock('../../src/dashboard/socket/emitter', () => ({
  emitGuildEvent: jest.fn(),
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

import { handleWhitelistApprovalButton } from '../../src/modules/whitelist/whitelistApprovalButton';

describe('Whitelist approval active-ban interlock', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindRequest.mockResolvedValue({
      id: 'req-1',
      guildId: 'guild-1',
      nitradoConnId: 'conn-1',
      gameId: 'BannedPlayer',
      requesterDiscordId: 'player-discord-1',
      status: 'PENDING',
    });
  });

  it('warns the approving admin and does not enqueue a whitelist add for an active exact-scope ban', async () => {
    mockBlockedByBan.mockResolvedValue(true);
    const reply = jest.fn(async (_options: unknown) => undefined);
    const deferUpdate = jest.fn(async () => undefined);
    const interaction = {
      customId: 'wlreq:a:req-1',
      guildId: 'guild-1',
      guild: { ownerId: 'admin-1' },
      user: { id: 'admin-1' },
      reply,
      deferUpdate,
      followUp: jest.fn(async () => undefined),
      message: {},
    } as any;

    await handleWhitelistApprovalButton(interaction);

    expect(mockBlockedByBan).toHaveBeenCalledWith(
      expect.anything(),
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      'BannedPlayer',
    );
    expect(reply).toHaveBeenCalledTimes(1);
    const replyOptions = reply.mock.calls[0]?.[0] as { embeds: Array<{ data: { description: string } }> } | undefined;
    expect(replyOptions?.embeds[0]?.data.description).toContain('aktiven Bannliste');
    expect(deferUpdate).not.toHaveBeenCalled();
    expect(mockTransaction).not.toHaveBeenCalled();
  });
});
