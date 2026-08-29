const mockFindRequest = jest.fn();
const mockFindTargets = jest.fn();
const mockUpdateRequest = jest.fn();
const mockTransaction = jest.fn();
const mockResolveDelegatedPermissionContext = jest.fn();
const mockEnqueueWhitelistAdd = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    whitelistRequest: {
      findUnique: mockFindRequest,
      updateMany: mockUpdateRequest,
    },
    nitradoConnection: { findMany: mockFindTargets },
    $transaction: mockTransaction,
  },
}));

jest.mock('../../src/modules/permissions/access', () => ({
  resolveDelegatedPermissionContext: mockResolveDelegatedPermissionContext,
}));

jest.mock('../../src/modules/whitelist/whitelistChannels', () => ({
  notifyRequesterDecision: jest.fn(),
}));

jest.mock('../../src/modules/whitelist/whitelistOutbox', () => ({
  enqueueWhitelistAdd: mockEnqueueWhitelistAdd,
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({
  emitGuildEvent: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

import { handleWhitelistApprovalButton } from '../../src/modules/whitelist/whitelistApprovalButton';

function interaction(messageDelete: jest.Mock, messageEdit: jest.Mock) {
  return {
    customId: 'wlreq:u:req-1',
    guildId: 'guild-1',
    guild: { ownerId: 'owner-1' },
    user: { id: 'admin-1' },
    message: { delete: messageDelete, edit: messageEdit },
    reply: jest.fn(async () => ({})),
    deferUpdate: jest.fn(async () => undefined),
    followUp: jest.fn(async () => ({})),
  } as any;
}

describe('universal whitelist temporary-claim race', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindRequest.mockResolvedValue({
      id: 'req-1',
      guildId: 'guild-1',
      nitradoConnId: 'conn-original',
      gameId: 'Player One',
      requesterDiscordId: 'requester-1',
    });
    mockFindTargets.mockResolvedValue([
      { id: 'conn-a', alias: 'A', slot: 1 },
    ]);
    mockResolveDelegatedPermissionContext.mockResolvedValue({
      member: {},
      permissions: new Set(['whitelist.manage']),
    });
  });

  it('keeps the request embed when a competing click loses the temporary claim and the claim owner later rolls back to PENDING', async () => {
    let fanoutReject!: (error: Error) => void;
    let fanoutStartedResolve!: () => void;
    const fanoutStarted = new Promise<void>(resolve => { fanoutStartedResolve = resolve; });
    const fanoutPending = new Promise<never>((_resolve, reject) => { fanoutReject = reject; });

    mockUpdateRequest
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mockTransaction.mockImplementation(() => {
      fanoutStartedResolve();
      return fanoutPending;
    });

    const messageDelete = jest.fn(async () => undefined);
    const messageEdit = jest.fn(async () => undefined);
    const first = interaction(messageDelete, messageEdit);
    const second = interaction(messageDelete, messageEdit);

    const firstRun = handleWhitelistApprovalButton(first);
    await fanoutStarted;

    await handleWhitelistApprovalButton(second);

    expect(mockUpdateRequest).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ status: 'PENDING' }),
    }));
    expect(messageDelete).not.toHaveBeenCalled();
    expect(messageEdit).not.toHaveBeenCalled();

    fanoutReject(new Error('simulierter Fan-out-Fehler'));
    await firstRun;

    expect(mockUpdateRequest).toHaveBeenNthCalledWith(3, expect.objectContaining({
      data: {
        status: 'PENDING',
        decidedByDiscordId: null,
        decidedAt: null,
      },
    }));
    expect(messageDelete).not.toHaveBeenCalled();
    expect(messageEdit).not.toHaveBeenCalled();
    expect(mockEnqueueWhitelistAdd).not.toHaveBeenCalled();
  });
});
