import { createHmac } from 'node:crypto';

const gameIdentityFindMany = jest.fn();
const playerSessionFindMany = jest.fn();
const txQuery = jest.fn();
const txExecute = jest.fn();
const transaction = jest.fn();

const SECRET = 'leave-test-secret-0123456789abcdef';

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: SECRET } },
}));

const tx = {
  $queryRawUnsafe: txQuery,
  $executeRawUnsafe: txExecute,
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    gameIdentityLink: { findMany: gameIdentityFindMany },
    playerSession: { findMany: playerSessionFindMany },
    $transaction: transaction,
  },
}));

import { identityHash } from '../../src/modules/linking/identity';
import {
  leavePlayerSubjectKey,
  runLeaveStatsSessionsCleanupStep,
} from '../../src/modules/moderation/leaveCleanupStatsSessions';

const GUILD = '12345678901234567';
const USER = '22345678901234567';
const CONN = 'conn-a';
const GUID = 'DAYZ-GUID-001';
const LINK_HASH = identityHash(GUID, SECRET);

function subjectKey(conn = CONN, hash = LINK_HASH): string {
  const digest = createHmac('sha256', SECRET)
    .update(`leave-player:v1:${GUILD}:${conn}:${hash}`)
    .digest('hex')
    .slice(0, 32);
  return `ps1_${digest}`;
}

beforeEach(() => {
  jest.clearAllMocks();
  gameIdentityFindMany.mockResolvedValue([{ nitradoConnId: CONN, identityHash: LINK_HASH }]);
  playerSessionFindMany.mockResolvedValue([
    { id: 'session-target', gameId: GUID, playerName: 'TargetPlayer', status: 'CLOSED' },
  ]);
  txQuery.mockResolvedValue([]);
  txExecute.mockImplementation(async (sql: string) => {
    if (sql.startsWith('LOCK TABLE')) return 0;
    if (sql.startsWith('UPDATE "PlayerSession"')) return 2;
    if (sql.startsWith('UPDATE "AdmEvent"')) return 3;
    if (sql.startsWith('DELETE FROM "LevelData"')) return 1;
    if (sql.startsWith('DELETE FROM "XpRecord"')) return 4;
    return 0;
  });
  transaction.mockImplementation(async (fn: (client: typeof tx) => unknown) => fn(tx));
});

describe('Leave-1D stats/session cleanup', () => {
  it('maps only the verified GUID-HMAC and ignores a foreign OPEN session', async () => {
    playerSessionFindMany.mockResolvedValue([
      { id: 'foreign', gameId: 'FOREIGN-GUID', playerName: 'ForeignPlayer', status: 'OPEN' },
      { id: 'target', gameId: GUID, playerName: 'TargetPlayer', status: 'CLOSED' },
    ]);

    const result = await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    expect(result).toMatchObject({
      state: 'DONE',
      links: 1,
      gameIdentities: 1,
      sessionsPseudonymized: 2,
      admEventsPseudonymized: 3,
      levelRowsDeleted: 1,
      xpRowsDeleted: 4,
    });
    const update = txExecute.mock.calls.find(call => String(call[0]).startsWith('UPDATE "PlayerSession"'));
    expect(update).toBeDefined();
    expect(update![1]).toBe(GUILD);
    expect(update![2]).toBe(CONN);
    expect(update![3]).toBe(GUID);
    expect(update![4]).toBe(subjectKey());
    expect(String(update![4])).toMatch(/^ps1_[a-f0-9]{32}$/);
    expect(String(update![4])).not.toContain(GUID);
  });

  it('returns WAITING without a transaction while the target has an OPEN session', async () => {
    playerSessionFindMany.mockResolvedValue([
      { id: 'open-target', gameId: GUID, playerName: 'TargetPlayer', status: 'OPEN' },
    ]);

    const result = await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    expect(result).toMatchObject({ state: 'WAITING', reason: 'ACTIVE_SESSION' });
    expect(transaction).not.toHaveBeenCalled();
    expect(txExecute).not.toHaveBeenCalled();
  });

  it('rechecks OPEN sessions under the transaction locks and aborts all mutations on a race', async () => {
    txQuery.mockResolvedValue([{ id: 'late-open' }]);

    const result = await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    expect(result).toMatchObject({ state: 'WAITING', reason: 'ACTIVE_SESSION' });
    const sqls = txExecute.mock.calls.map(call => String(call[0]));
    expect(sqls.filter(sql => sql.startsWith('LOCK TABLE'))).toHaveLength(2);
    expect(sqls.some(sql => sql.startsWith('UPDATE '))).toBe(false);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM'))).toBe(false);
  });

  it('preserves session anti-replay and reward watermarks while removing identity fields', async () => {
    await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    const sql = String(txExecute.mock.calls.find(call => String(call[0]).startsWith('UPDATE "PlayerSession"'))![0]);
    expect(sql).toContain('"gameId"=$4');
    expect(sql).toContain('"playerName"=NULL');
    expect(sql).not.toContain('"bucketsCredited"');
    expect(sql).not.toContain('"bucketsEarned"');
    expect(sql).not.toContain('"durationSeconds"');
    expect(sql).not.toContain('"connectEventId"');
    expect(sql).not.toContain('"disconnectEventId"');
    expect(sql).not.toContain('DELETE FROM "PlayerSession"');
  });

  it('pseudonymizes normalized ADM identity and tombstones the raw ADM line without deleting the event', async () => {
    await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    const call = txExecute.mock.calls.find(entry => String(entry[0]).startsWith('UPDATE "AdmEvent"'));
    expect(call).toBeDefined();
    const sql = String(call![0]);
    expect(sql).toContain("\"rawLine\"='[LEAVE_RESET] eventKey=' || \"eventKey\"");
    expect(sql).toContain('"actorGameId"=CASE');
    expect(sql).toContain('"actorName"=CASE');
    expect(sql).toContain('"targetGameId"=CASE');
    expect(sql).toContain('"targetName"=CASE');
    expect(sql).not.toContain('DELETE FROM "AdmEvent"');
    expect(call![1]).toBe(GUILD);
    expect(call![2]).toBe(CONN);
    expect(call![3]).toBe(GUID);
    expect(call![4]).toBe(subjectKey());
  });

  it('deletes Discord XP/leaderboard rows only through exact guild + Discord-user ownership', async () => {
    await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    const level = txExecute.mock.calls.find(call => String(call[0]).startsWith('DELETE FROM "LevelData"'))!;
    const xp = txExecute.mock.calls.find(call => String(call[0]).startsWith('DELETE FROM "XpRecord"'))!;
    for (const call of [level, xp]) {
      expect(String(call[0])).toContain('"guildId"=$1');
      expect(String(call[0])).toContain('u."discordId"=$2');
      expect(call[1]).toBe(GUILD);
      expect(call[2]).toBe(USER);
    }
  });

  it('is retry-idempotent when session evidence is already pseudonymized', async () => {
    playerSessionFindMany.mockResolvedValue([
      { id: 'already-clean', gameId: subjectKey(), playerName: null, status: 'CLOSED' },
    ]);

    const result = await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    expect(result).toMatchObject({ state: 'DONE', sessionsPseudonymized: 0, admEventsPseudonymized: 0 });
    const sqls = txExecute.mock.calls.map(call => String(call[0]));
    expect(sqls.some(sql => sql.startsWith('UPDATE "PlayerSession"'))).toBe(false);
    expect(sqls.some(sql => sql.startsWith('UPDATE "AdmEvent"'))).toBe(false);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM "LevelData"'))).toBe(true);
    expect(sqls.some(sql => sql.startsWith('DELETE FROM "XpRecord"'))).toBe(true);
  });

  it('fails closed when a VERIFIED link has neither raw nor already-pseudonymized session evidence', async () => {
    playerSessionFindMany.mockResolvedValue([
      { id: 'foreign', gameId: 'FOREIGN-GUID', playerName: 'ForeignPlayer', status: 'CLOSED' },
    ]);

    await expect(runLeaveStatsSessionsCleanupStep(GUILD, USER)).rejects.toThrow(/keine sichere Session-Evidenz/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('paginates beyond 1000 sessions instead of silently missing an old verified identity', async () => {
    const firstPage = Array.from({ length: 1000 }, (_, index) => ({
      id: `foreign-${String(index).padStart(4, '0')}`,
      gameId: `FOREIGN-${index}`,
      playerName: `Foreign-${index}`,
      status: 'CLOSED',
    }));
    playerSessionFindMany
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([{ id: 'target-last', gameId: GUID, playerName: 'TargetPlayer', status: 'CLOSED' }]);

    const result = await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    expect(result.state).toBe('DONE');
    expect(playerSessionFindMany).toHaveBeenCalledTimes(2);
    expect(playerSessionFindMany.mock.calls[1][0]).toMatchObject({
      where: { guildId: GUILD, nitradoConnId: CONN },
      cursor: { id: firstPage[firstPage.length - 1].id },
      skip: 1,
    });
  });

  it('creates distinct pseudonyms and exact mutations for separate gameservers', async () => {
    const connB = 'conn-b';
    const guidB = 'DAYZ-GUID-002';
    const hashB = identityHash(guidB, SECRET);
    gameIdentityFindMany.mockResolvedValue([
      { nitradoConnId: CONN, identityHash: LINK_HASH },
      { nitradoConnId: connB, identityHash: hashB },
    ]);
    playerSessionFindMany.mockImplementation(async (args: { where: { nitradoConnId: string } }) => {
      if (args.where.nitradoConnId === connB) {
        return [{ id: 'session-b', gameId: guidB, playerName: 'TargetB', status: 'CLOSED' }];
      }
      return [{ id: 'session-a', gameId: GUID, playerName: 'TargetA', status: 'CLOSED' }];
    });

    const result = await runLeaveStatsSessionsCleanupStep(GUILD, USER);

    expect(result).toMatchObject({ state: 'DONE', links: 2, gameIdentities: 2 });
    const updates = txExecute.mock.calls.filter(call => String(call[0]).startsWith('UPDATE "PlayerSession"'));
    expect(updates).toHaveLength(2);
    expect(new Set(updates.map(call => String(call[4]))).size).toBe(2);
    expect(updates.map(call => call[2])).toEqual(expect.arrayContaining([CONN, connB]));
  });

  it('validates the stable player subject-key contract', () => {
    expect(leavePlayerSubjectKey(GUILD, CONN, LINK_HASH, SECRET)).toBe(subjectKey());
    expect(() => leavePlayerSubjectKey(GUILD, CONN, 'not-a-hash', SECRET)).toThrow(/IdentityHash/);
    expect(() => leavePlayerSubjectKey(GUILD, CONN, LINK_HASH, 'too-short')).toThrow(/zu kurz/);
  });
});
