const cleanupGuard = jest.fn();

jest.mock('../../src/modules/moderation/leaveCleanupGuard', () => ({
  assertNoOpenLeaveCleanupRequest: cleanupGuard,
  LeaveCleanupPendingError: class LeaveCleanupPendingError extends Error {
    constructor() {
      super('Leave-Cleanup noch nicht sicher abgeschlossen');
      this.name = 'LeaveCleanupPendingError';
    }
  },
}));

import {
  MIN_LINK_PLAYTIME_SECONDS,
  findVerifiedLinkDetails,
  forceLinkByPlayerName,
  linkByPlayerName,
  listVerifiedLinkDetails,
  resolveVerifiedUser,
  unlinkUser,
  type GameIdentityRow,
  type PlayerSessionLinkRow,
  type SessionLinkClient,
} from '../../src/modules/linking/linkService';
import { identityHash } from '../../src/modules/linking/identity';

const SECRET = '0123456789abcdef0123456789abcdef';
const SCOPE = { guildId: '123456789012345678', nitradoConnId: 'conn-1' };
const USER_1 = '223456789012345678';
const USER_OWNER = '323456789012345678';
const USER_OTHER = '423456789012345678';
const NOW = new Date('2026-08-16T01:00:00.000Z');

interface StoredLink extends GameIdentityRow {
  guildId: string;
  nitradoConnId: string;
  verifiedAt?: Date | null;
  unlinkedAt?: Date | null;
}

interface LeaveState {
  open?: boolean;
  completedAt?: Date | null;
}

function session(
  overrides: Partial<PlayerSessionLinkRow> & Pick<PlayerSessionLinkRow, 'gameId' | 'playerName'>,
): PlayerSessionLinkRow {
  return {
    id: overrides.id ?? `session-${Math.random()}`,
    gameId: overrides.gameId,
    playerName: overrides.playerName,
    connectedAt: overrides.connectedAt ?? new Date('2026-08-16T00:50:00.000Z'),
    disconnectedAt: overrides.disconnectedAt ?? new Date('2026-08-16T00:56:00.000Z'),
    durationSeconds: overrides.durationSeconds ?? 360,
    status: overrides.status ?? 'CLOSED',
    createdAt: overrides.createdAt ?? new Date('2026-08-16T00:50:00.000Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-08-16T00:56:00.000Z'),
  };
}

function makeClient(
  initialLinks: StoredLink[] = [],
  sessions: PlayerSessionLinkRow[] = [],
  leaveState: LeaveState = {},
) {
  const links = new Map<string, StoredLink>();
  for (const row of initialLinks) links.set(`${row.nitradoConnId}:${row.userDiscordId}`, { ...row });

  function linkMatches(row: StoredLink, where: Record<string, any>): boolean {
    if (where.guildId && row.guildId !== where.guildId) return false;
    if (where.nitradoConnId && row.nitradoConnId !== where.nitradoConnId) return false;
    if (where.userDiscordId && row.userDiscordId !== where.userDiscordId) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.identityHash) {
      if (typeof where.identityHash === 'string' && row.identityHash !== where.identityHash) return false;
      if (where.identityHash.in && !where.identityHash.in.includes(row.identityHash)) return false;
    }
    if (where.NOT?.userDiscordId && row.userDiscordId === where.NOT.userDiscordId) return false;
    return true;
  }

  function sessionMatches(row: PlayerSessionLinkRow, where: Record<string, any>): boolean {
    if (where.guildId && where.guildId !== SCOPE.guildId) return false;
    if (where.nitradoConnId && where.nitradoConnId !== SCOPE.nitradoConnId) return false;
    if (where.playerName !== undefined && row.playerName !== where.playerName) return false;
    if (where.gameId !== undefined && row.gameId !== where.gameId) return false;
    return true;
  }

  const gameIdentityLink = {
    findFirst: async (args: unknown) => {
      const where = (args as { where: Record<string, any> }).where;
      return [...links.values()].find(row => linkMatches(row, where)) ?? null;
    },
    findMany: async (args: unknown) => {
      const where = (args as { where: Record<string, any> }).where;
      return [...links.values()].filter(row => linkMatches(row, where));
    },
    upsert: async ({ where, create, update }: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const keyData = where.guildId_nitradoConnId_userDiscordId as {
        guildId: string;
        nitradoConnId: string;
        userDiscordId: string;
      };
      const key = `${keyData.nitradoConnId}:${keyData.userDiscordId}`;
      const current = links.get(key);
      const next = current
        ? { ...current, ...update } as StoredLink
        : { ...create } as unknown as StoredLink;

      if (next.identityHash && next.status === 'VERIFIED') {
        const duplicate = [...links.values()].find(row =>
          row.guildId === next.guildId
          && row.nitradoConnId === next.nitradoConnId
          && row.userDiscordId !== next.userDiscordId
          && row.status === 'VERIFIED'
          && row.identityHash === next.identityHash,
        );
        if (duplicate) {
          const error = new Error('unique') as Error & { code: string };
          error.code = 'P2002';
          throw error;
        }
      }
      links.set(key, next);
      return next;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      let count = 0;
      for (const [key, row] of links) {
        const typedWhere = where as Record<string, any>;
        if (typedWhere.guildId && row.guildId !== typedWhere.guildId) continue;
        if (typedWhere.nitradoConnId && row.nitradoConnId !== typedWhere.nitradoConnId) continue;
        if (typedWhere.userDiscordId && row.userDiscordId !== typedWhere.userDiscordId) continue;
        if (typedWhere.status?.in && !typedWhere.status.in.includes(row.status)) continue;
        links.set(key, { ...row, ...data } as StoredLink);
        count++;
      }
      return { count };
    },
  };

  const leaveFenceQuery = jest.fn(async (_query: string, ..._values: unknown[]) => []);
  const deletionRequestFindFirst = jest.fn(async (args: unknown) => {
    const where = (args as { where: Record<string, any> }).where;
    if (typeof where.status === 'object' && Array.isArray(where.status?.in)) {
      return leaveState.open ? { id: 'leave-open' } : null;
    }
    if (where.status === 'COMPLETED' && leaveState.completedAt !== undefined) {
      return { id: 'leave-completed', completedAt: leaveState.completedAt };
    }
    return null;
  });

  const client: SessionLinkClient = {
    gameIdentityLink,
    playerSession: {
      findMany: async (args: unknown) => {
        const where = (args as { where: Record<string, any> }).where;
        return sessions.filter(row => sessionMatches(row, where));
      },
    },
    $transaction: async work => work({
      $queryRawUnsafe: async <T = unknown>(query: string, ...values: unknown[]): Promise<T> => {
        await leaveFenceQuery(query, ...values);
        return [] as unknown as T;
      },
      dataDeletionRequest: { findFirst: deletionRequestFindFirst },
      gameIdentityLink,
    }),
  };

  return { client, links, leaveFenceQuery, deletionRequestFindFirst };
}

beforeEach(() => {
  cleanupGuard.mockReset();
  cleanupGuard.mockResolvedValue(undefined);
});

describe('Konsolen-Linking ueber PlayerSessions', () => {
  it('blockiert Rejoin-Linking vor jeder Session-Aufloesung solange der Leave-Cleanup offen ist', async () => {
    cleanupGuard.mockRejectedValue(new Error('Leave-Cleanup noch offen'));
    const { client, links } = makeClient([], [
      session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 600 }),
    ]);
    const sessionSpy = jest.spyOn(client.playerSession, 'findMany');

    await expect(linkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW))
      .rejects.toThrow(/Leave-Cleanup/);
    expect(cleanupGuard).toHaveBeenCalledWith(SCOPE.guildId, USER_1);
    expect(sessionSpy).not.toHaveBeenCalled();
    expect(links.size).toBe(0);
  });

  it('lehnt einen unbekannten PSN-/Xbox-Namen ab', async () => {
    const { client } = makeClient();
    const result = await linkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'PLAYER_NOT_SEEN', playerName: 'Void__Architect' });
  });

  it('antwortet vor 5 Minuten mit dem aktuell nachgewiesenen Spielzeitstand', async () => {
    const { client } = makeClient([], [
      session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 240 }),
    ]);
    const result = await linkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW);
    expect(result).toEqual({
      ok: false,
      reason: 'PLAYTIME_TOO_SHORT',
      playerName: 'Void__Architect',
      playedSeconds: 240,
      requiredSeconds: MIN_LINK_PLAYTIME_SECONDS,
    });
  });

  it('zaehlt bei einer offenen Session die Live-Zeit bis jetzt', async () => {
    const { client } = makeClient([], [
      session({
        gameId: 'guid-live',
        playerName: 'Void__Architect',
        connectedAt: new Date('2026-08-16T00:54:30.000Z'),
        disconnectedAt: null,
        durationSeconds: 0,
        status: 'OPEN',
      }),
    ]);
    const result = await linkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.playedSeconds).toBe(330);
  });

  it('verknuepft nach mindestens 5 Minuten den Discord-Account mit dem GUID-Hash unter derselben Leave-Fence', async () => {
    const { client, links, leaveFenceQuery, deletionRequestFindFirst } = makeClient([], [
      session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 301 }),
    ]);
    const result = await linkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW);
    expect(result).toMatchObject({
      ok: true,
      alreadyLinked: false,
      playerName: 'Void__Architect',
      gameId: 'guid-1',
      playedSeconds: 301,
    });
    expect(leaveFenceQuery).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      `leave-job:v1:${SCOPE.guildId}:${USER_1}`,
    );
    expect(deletionRequestFindFirst).toHaveBeenCalledTimes(2);
    expect(links.get(`conn-1:${USER_1}`)).toMatchObject({
      identityHash: identityHash('guid-1', SECRET),
      status: 'VERIFIED',
      verifiedAt: NOW,
      challengeCode: null,
      challengeExpiresAt: null,
    });
  });

  it('faengt ein Leave ab, das nach dem schnellen Guard aber vor dem finalen Link-Commit eingequeued wurde', async () => {
    const { client, links } = makeClient([], [
      session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 600 }),
    ], { open: true });

    await expect(linkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW))
      .rejects.toThrow(/Leave-Cleanup/);
    expect(links.size).toBe(0);
  });

  it('faengt einen Cleanup ab, der nach Operationsstart bereits vollendet wurde und keinen OPEN-Job mehr besitzt', async () => {
    const completedAt = new Date(NOW.getTime() + 1_000);
    const { client, links } = makeClient([], [
      session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 600 }),
    ], { completedAt });

    await expect(linkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW))
      .rejects.toThrow(/Leave-Cleanup/);
    expect(links.size).toBe(0);
  });

  it('erlaubt einen legitimen frischen Rejoin nach einem bereits vorher abgeschlossenen Cleanup', async () => {
    const completedAt = new Date(NOW.getTime() - 1_000);
    const { client, links } = makeClient([], [
      session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 600 }),
    ], { completedAt });

    await expect(linkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW))
      .resolves.toMatchObject({ ok: true, alreadyLinked: false });
    expect(links.get(`conn-1:${USER_1}`)?.verifiedAt).toEqual(NOW);
  });

  it('erlaubt denselben Namen/GUID nicht fuer einen zweiten Discord-Account', async () => {
    const hash = identityHash('guid-1', SECRET);
    const { client } = makeClient([
      {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER_OWNER,
        identityHash: hash,
        status: 'VERIFIED',
        challengeCode: null,
        challengeExpiresAt: null,
        verifiedAt: NOW,
      },
    ], [session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 600 })]);

    const result = await linkByPlayerName(client, SCOPE, USER_OTHER, 'Void__Architect', SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'PLAYER_NAME_TAKEN', playerName: 'Void__Architect' });
  });

  it('verweigert einen zweiten unterschiedlichen Spieler fuer denselben Discord-Account', async () => {
    const { client } = makeClient([
      {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER_1,
        identityHash: identityHash('guid-old', SECRET),
        status: 'VERIFIED',
        challengeCode: null,
        challengeExpiresAt: null,
        verifiedAt: NOW,
      },
    ], [session({ gameId: 'guid-new', playerName: 'PlayerTwo', durationSeconds: 600 })]);

    const result = await linkByPlayerName(client, SCOPE, USER_1, 'PlayerTwo', SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'USER_ALREADY_LINKED', playerName: 'PlayerTwo' });
  });

  it('fail-closed bei demselben Namen mit mehreren beobachteten GUIDs', async () => {
    const { client } = makeClient([], [
      session({ gameId: 'guid-1', playerName: 'DuplicateName' }),
      session({ gameId: 'guid-2', playerName: 'DuplicateName' }),
    ]);
    const result = await linkByPlayerName(client, SCOPE, USER_1, 'DuplicateName', SECRET, NOW);
    expect(result).toEqual({ ok: false, reason: 'AMBIGUOUS_PLAYER_NAME', playerName: 'DuplicateName' });
  });

  it('Force-Link umgeht nur die 5-Minuten-Grenze, nicht den Leave-Cleanup-Guard oder die Session-Aufloesung', async () => {
    const { client } = makeClient([], [
      session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 30 }),
    ]);
    const result = await forceLinkByPlayerName(client, SCOPE, USER_1, 'Void__Architect', SECRET, NOW);
    expect(result).toMatchObject({ ok: true, playerName: 'Void__Architect', gameId: 'guid-1', playedSeconds: 30 });
    expect(cleanupGuard).toHaveBeenCalledWith(SCOPE.guildId, USER_1);
  });
});

describe('Unlink, Reward-Aufloesung und GUID-Listen', () => {
  it('Unlink gibt den GUID-Hash fuer eine spaetere Neuverknuepfung frei', async () => {
    const { client, links } = makeClient([
      {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER_1,
        identityHash: identityHash('guid-1', SECRET),
        status: 'VERIFIED',
        challengeCode: null,
        challengeExpiresAt: null,
        verifiedAt: NOW,
      },
    ]);
    expect(await unlinkUser(client, SCOPE, USER_1, NOW)).toBe(true);
    expect(links.get(`conn-1:${USER_1}`)).toMatchObject({ status: 'UNLINKED', identityHash: null });
  });

  it('resolveVerifiedUser bleibt die Economy-Bruecke GUID -> Discord', async () => {
    const { client } = makeClient([
      {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER_1,
        identityHash: identityHash('guid-1', SECRET),
        status: 'VERIFIED',
        challengeCode: null,
        challengeExpiresAt: null,
        verifiedAt: NOW,
      },
    ]);
    expect(await resolveVerifiedUser(client, SCOPE, 'guid-1', SECRET)).toBe(USER_1);
    expect(await resolveVerifiedUser(client, SCOPE, 'guid-other', SECRET)).toBeNull();
  });

  it('Admin-Liste zeigt Discord, exakten Spielernamen und aktuelle GUID aus PlayerSession', async () => {
    const { client } = makeClient([
      {
        guildId: SCOPE.guildId,
        nitradoConnId: SCOPE.nitradoConnId,
        userDiscordId: USER_1,
        identityHash: identityHash('guid-1', SECRET),
        status: 'VERIFIED',
        challengeCode: null,
        challengeExpiresAt: null,
        verifiedAt: NOW,
      },
    ], [session({ gameId: 'guid-1', playerName: 'Void__Architect', durationSeconds: 600 })]);

    expect(await listVerifiedLinkDetails(client, SCOPE, SECRET)).toEqual([
      {
        userDiscordId: USER_1,
        playerName: 'Void__Architect',
        gameId: 'guid-1',
        verifiedAt: NOW,
      },
    ]);
    expect(await findVerifiedLinkDetails(client, SCOPE, SECRET, { identifier: 'Void__Architect' }))
      .toHaveLength(1);
    expect(await findVerifiedLinkDetails(client, SCOPE, SECRET, { identifier: 'guid-1' }))
      .toHaveLength(1);
  });
});