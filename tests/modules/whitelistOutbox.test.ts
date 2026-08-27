const mockPlayerSessionFindMany = jest.fn();
const mockGameIdentityLinkFindMany = jest.fn();
const mockHasOpenLeaveCleanupRequest = jest.fn();
const mockIdentityHash = jest.fn((gameId: string) => `hash:${gameId}`);

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    playerSession: { findMany: mockPlayerSessionFindMany },
    gameIdentityLink: { findMany: mockGameIdentityLinkFindMany },
  },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: 'test-encryption-key' } },
}));

jest.mock('../../src/modules/linking/identity', () => ({
  identityHash: mockIdentityHash,
}));

jest.mock('../../src/modules/moderation/leaveCleanupGuard', () => ({
  hasOpenLeaveCleanupRequest: mockHasOpenLeaveCleanupRequest,
}));

import {
  enqueueWhitelistAdd,
  enqueueWhitelistRemove,
  WhitelistAddBlockedByLeaveCleanupError,
  type WhitelistOutboxClient,
} from '../../src/modules/whitelist/whitelistOutbox';
import { WHITELIST_REMOVE_SAFETY_INTENT } from '../../src/modules/whitelist/whitelistJobSafety';

const SCOPE = { guildId: 'guild-a', nitradoConnId: 'conn-a' };

type ExistingJob = { operation: 'WHITELIST_ADD' | 'WHITELIST_REMOVE'; payload: unknown };

function makeClient(existingJobs: ExistingJob[] = []) {
  const create = jest.fn(async (_args: unknown) => ({}));
  const findMany = jest.fn(async (args: unknown) => {
    const operation = (args as { where?: { operation?: string } })?.where?.operation;
    return existingJobs
      .filter(job => !operation || job.operation === operation)
      .map(job => ({ payload: job.payload }));
  });
  const queryRaw = jest.fn(async (_query: string, ..._values: unknown[]) => []);
  const client = {
    $queryRawUnsafe: queryRaw,
    nitradoJob: { findMany, create },
  } as WhitelistOutboxClient;
  return { client, create, findMany, queryRaw };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockPlayerSessionFindMany.mockResolvedValue([]);
  mockGameIdentityLinkFindMany.mockResolvedValue([]);
  mockHasOpenLeaveCleanupRequest.mockResolvedValue(false);
  mockIdentityHash.mockImplementation((gameId: string) => `hash:${gameId}`);
});

describe('Nitrado-1A/1U Whitelist-Outbox', () => {
  it('legt ADD erst unter Connection- und danach Subject-xact-lock an', async () => {
    const { client, create, queryRaw } = makeClient();

    await expect(enqueueWhitelistAdd(client, SCOPE, 'Player One')).resolves.toBe(true);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    for (const call of queryRaw.mock.calls) {
      expect(call[0]).toBe('SELECT pg_advisory_xact_lock($1, $2)');
      expect(call[1]).toEqual(expect.any(Number));
      expect(call[2]).toEqual(expect.any(Number));
    }
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[1]);
    expect(queryRaw.mock.invocationCallOrder[1]).toBeLessThan(create.mock.invocationCallOrder[0]);
    expect(create).toHaveBeenCalledWith({
      data: {
        guildId: 'guild-a',
        nitradoConnId: 'conn-a',
        operation: 'WHITELIST_ADD',
        payload: { gameId: 'Player One' },
      },
    });
  });

  it('blockiert ein erneutes ADD fuer einen verifiziert zugeordneten Spieler mit offenem Leave-Cleanup', async () => {
    const { client, create, queryRaw } = makeClient();
    mockPlayerSessionFindMany.mockResolvedValue([{ gameId: 'GUID-1' }]);
    mockGameIdentityLinkFindMany.mockResolvedValue([{ userDiscordId: 'user-1' }]);
    mockHasOpenLeaveCleanupRequest.mockResolvedValue(true);

    let thrown: unknown;
    try {
      await enqueueWhitelistAdd(client, SCOPE, 'Player One');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(WhitelistAddBlockedByLeaveCleanupError);
    expect(thrown).toMatchObject({ status: 409, code: 'LEAVE_CLEANUP_PENDING' });
    expect(mockPlayerSessionFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
      }),
    }));
    expect(mockGameIdentityLinkFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        status: 'VERIFIED',
      }),
    }));
    expect(queryRaw).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('laesst denselben verifizierten Spieler nach abgeschlossenem Leave-Cleanup wieder normal zu', async () => {
    const { client, create } = makeClient();
    mockPlayerSessionFindMany.mockResolvedValue([{ gameId: 'GUID-1' }]);
    mockGameIdentityLinkFindMany.mockResolvedValue([{ userDiscordId: 'user-1' }]);
    mockHasOpenLeaveCleanupRequest.mockResolvedValue(false);

    await expect(enqueueWhitelistAdd(client, SCOPE, 'Player One')).resolves.toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('markiert jeden neuen REMOVE mit dem V2-Safety-Intent und prueft dafuer keinen ADD-Barrier', async () => {
    const { client, create } = makeClient();

    await expect(enqueueWhitelistRemove(client, SCOPE, 'Player One')).resolves.toBe(true);

    expect(mockPlayerSessionFindMany).not.toHaveBeenCalled();
    expect(mockHasOpenLeaveCleanupRequest).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith({
      data: {
        guildId: 'guild-a',
        nitradoConnId: 'conn-a',
        operation: 'WHITELIST_REMOVE',
        payload: {
          gameId: 'Player One',
          removeSafetyIntent: WHITELIST_REMOVE_SAFETY_INTENT,
        },
      },
    });
  });

  it('dedupliziert Namen case-insensitiv und trim-bewusst innerhalb derselben Operation', async () => {
    const { client, create } = makeClient([
      { operation: 'WHITELIST_ADD', payload: { gameId: ' PLAYER ONE ' } },
    ]);

    await expect(enqueueWhitelistAdd(client, SCOPE, 'player one')).resolves.toBe(false);

    expect(create).not.toHaveBeenCalled();
  });

  it('trennt ADD und REMOVE als unterschiedliche Intents', async () => {
    const remove = makeClient([
      { operation: 'WHITELIST_ADD', payload: { gameId: 'Player One' } },
    ]);

    await expect(enqueueWhitelistRemove(remove.client, SCOPE, 'Player One')).resolves.toBe(true);
    expect(remove.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ operation: 'WHITELIST_REMOVE' }),
    }));
    expect(remove.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        operation: 'WHITELIST_REMOVE',
        payload: expect.objectContaining({
          gameId: 'Player One',
          removeSafetyIntent: WHITELIST_REMOVE_SAFETY_INTENT,
        }),
      }),
    }));
  });

  it('laesst einen aktiven unmarkierten Legacy-REMOVE keinen neuen sicheren REMOVE deduplizieren', async () => {
    const remove = makeClient([
      { operation: 'WHITELIST_REMOVE', payload: { gameId: 'Player One' } },
    ]);

    await expect(enqueueWhitelistRemove(remove.client, SCOPE, 'player one')).resolves.toBe(true);
    expect(remove.create).toHaveBeenCalledTimes(1);
    expect(remove.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          gameId: 'player one',
          removeSafetyIntent: WHITELIST_REMOVE_SAFETY_INTENT,
        }),
      }),
    }));
  });

  it('dedupliziert einen bereits aktiven markierten REMOVE fuer denselben Namen', async () => {
    const remove = makeClient([
      {
        operation: 'WHITELIST_REMOVE',
        payload: { gameId: ' PLAYER ONE ', removeSafetyIntent: WHITELIST_REMOVE_SAFETY_INTENT },
      },
    ]);

    await expect(enqueueWhitelistRemove(remove.client, SCOPE, 'player one')).resolves.toBe(false);
    expect(remove.create).not.toHaveBeenCalled();
  });

  it('teilt die Connection-Barriere pro Connection, aber trennt Subject-Locks nach Operation/Name', async () => {
    const a = makeClient();
    const b = makeClient();
    const c = makeClient();

    await enqueueWhitelistAdd(a.client, SCOPE, 'Player One');
    await enqueueWhitelistAdd(b.client, { ...SCOPE, nitradoConnId: 'conn-b' }, 'Player One');
    await enqueueWhitelistRemove(c.client, SCOPE, 'Player One');

    // Erster Lock = Connection-Barriere.
    expect(a.queryRaw.mock.calls[0].slice(1)).not.toEqual(b.queryRaw.mock.calls[0].slice(1));
    expect(a.queryRaw.mock.calls[0].slice(1)).toEqual(c.queryRaw.mock.calls[0].slice(1));
    // Zweiter Lock = konkreter Subject-Key.
    expect(a.queryRaw.mock.calls[1].slice(1)).not.toEqual(c.queryRaw.mock.calls[1].slice(1));
  });

  it('lehnt leere Identifier ab, bevor Lifecycle-Lookup, DB-Lock oder Job entsteht', async () => {
    const { client, create, queryRaw } = makeClient();

    await expect(enqueueWhitelistAdd(client, SCOPE, '   ')).rejects.toThrow(/leerer Gameserver-Identifier/);

    expect(mockPlayerSessionFindMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
