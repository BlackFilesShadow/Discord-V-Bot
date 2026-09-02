const mockFindRequest = jest.fn();
const mockFindTargets = jest.fn();
const mockTransaction = jest.fn();
const mockResolveDelegatedPermissionContext = jest.fn();
const mockEnqueueWhitelistAdd = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    whitelistRequest: { findUnique: mockFindRequest },
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

jest.mock('../../src/modules/bans/whitelistBanGuard', () => ({
  ACTIVE_BAN_WHITELIST_WARNING: 'active ban',
  isWhitelistBlockedByActiveServerBan: jest.fn(async () => false),
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({
  emitGuildEvent: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

import { handleWhitelistApprovalButton } from '../../src/modules/whitelist/whitelistApprovalButton';

function interaction(messageDelete: jest.Mock, messageEdit: jest.Mock, userId = 'admin-1') {
  return {
    customId: 'wlreq:u:req-1',
    guildId: 'guild-1',
    guild: { ownerId: 'owner-1' },
    user: { id: userId },
    message: { delete: messageDelete, edit: messageEdit },
    reply: jest.fn(async () => ({})),
    deferUpdate: jest.fn(async () => undefined),
    followUp: jest.fn(async () => ({})),
  } as any;
}

type RequestStatus = 'PENDING' | 'APPROVED';

function transactionClient(getStatus: () => RequestStatus, setStatus: (status: RequestStatus) => void) {
  return {
    whitelistRequest: {
      updateMany: jest.fn(async (args: { where: { status: RequestStatus }; data: { status: RequestStatus } }) => {
        if (getStatus() !== args.where.status) return { count: 0 };
        setStatus(args.data.status);
        return { count: 1 };
      }),
    },
    whitelistEntry: { upsert: jest.fn(async () => ({})) },
  };
}

describe('universal whitelist atomic claim / fan-out race', () => {
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

  it('rolls APPROVED back with the first target when enqueue fails, so no approved request can exist without entry/outbox commit', async () => {
    let status: RequestStatus = 'PENDING';
    mockTransaction.mockImplementation(async callback => {
      const before = status;
      const tx = transactionClient(() => status, next => { status = next; });
      try {
        return await callback(tx);
      } catch (error) {
        status = before;
        throw error;
      }
    });
    mockEnqueueWhitelistAdd.mockRejectedValue(new Error('simulierter Outbox-Fehler'));

    const messageDelete = jest.fn(async () => undefined);
    const messageEdit = jest.fn(async () => undefined);

    await handleWhitelistApprovalButton(interaction(messageDelete, messageEdit));

    expect(status).toBe('PENDING');
    expect(messageDelete).not.toHaveBeenCalled();
    expect(messageEdit).not.toHaveBeenCalled();
    expect(mockEnqueueWhitelistAdd).toHaveBeenCalledTimes(1);
  });

  it('serializes parallel clicks so a second click can claim after the first atomic attempt rolls back', async () => {
    let status: RequestStatus = 'PENDING';
    let tail: Promise<void> = Promise.resolve();

    mockTransaction.mockImplementation(async callback => {
      const previous = tail;
      let release!: () => void;
      tail = new Promise<void>(resolve => { release = resolve; });
      await previous;

      const before = status;
      const tx = transactionClient(() => status, next => { status = next; });
      try {
        return await callback(tx);
      } catch (error) {
        status = before;
        throw error;
      } finally {
        release();
      }
    });

    let firstReject!: (error: Error) => void;
    let firstEnqueueStartedResolve!: () => void;
    const firstEnqueueStarted = new Promise<void>(resolve => { firstEnqueueStartedResolve = resolve; });
    const firstEnqueue = new Promise<never>((_resolve, reject) => { firstReject = reject; });
    mockEnqueueWhitelistAdd
      .mockImplementationOnce(() => {
        firstEnqueueStartedResolve();
        return firstEnqueue;
      })
      .mockResolvedValueOnce(true);

    const messageDelete = jest.fn(async () => undefined);
    const messageEdit = jest.fn(async () => undefined);
    const firstRun = handleWhitelistApprovalButton(interaction(messageDelete, messageEdit, 'admin-1'));
    await firstEnqueueStarted;

    const secondRun = handleWhitelistApprovalButton(interaction(messageDelete, messageEdit, 'admin-2'));
    await Promise.resolve();

    expect(messageDelete).not.toHaveBeenCalled();
    expect(messageEdit).not.toHaveBeenCalled();

    firstReject(new Error('simulierter erster Fan-out-Fehler'));
    await Promise.all([firstRun, secondRun]);

    expect(status).toBe('APPROVED');
    expect(mockEnqueueWhitelistAdd).toHaveBeenCalledTimes(2);
    expect(messageDelete).toHaveBeenCalledTimes(1);
    expect(messageEdit).not.toHaveBeenCalled();
  });
});
