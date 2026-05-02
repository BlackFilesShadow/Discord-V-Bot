/**
 * P1 — DevSession Lifecycle Tests.
 *
 * Verifiziert:
 *   - cleanupExpiredDevSessions: markiert abgelaufene Sessions, hard-deletes alt-revoked
 *   - maybeAutoExtendDevSession: extend nur innerhalb Threshold, capped bei MAX_LIFETIME
 *   - forceRevokeDevSession: validiert reason, schreibt Audit, idempotent
 *   - listActiveDevSessions: liefert remainingMs/totalLifetimeMs
 */

const findMany = jest.fn();
const updateMany = jest.fn();
const deleteOne = jest.fn();
const findUnique = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    devSession: {
      findMany: (...a: unknown[]) => findMany(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      delete: (...a: unknown[]) => deleteOne(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
  },
}));

const auditCalls: Array<{ action: string; category: string; meta: unknown }> = [];
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn((action: string, category: string, details: unknown) => {
    auditCalls.push({ action, category, meta: details });
  }),
  logAuditDb: jest.fn((action: string, category: string, meta: unknown) => {
    auditCalls.push({ action, category, meta });
  }),
}));

import {
  cleanupExpiredDevSessions,
  maybeAutoExtendDevSession,
  forceRevokeDevSession,
  listActiveDevSessions,
  SESSION_AUTO_EXTEND_THRESHOLD_MS,
  SESSION_AUTO_EXTEND_STEP_MS,
  SESSION_MAX_LIFETIME_MS,
} from '../../src/dashboard/services/devSessionLifecycle';

beforeEach(() => {
  findMany.mockReset();
  updateMany.mockReset();
  deleteOne.mockReset();
  findUnique.mockReset();
  auditCalls.length = 0;
});

describe('cleanupExpiredDevSessions', () => {
  it('markiert abgelaufene Sessions als revoked (revokedAt = expiresAt)', async () => {
    const now = new Date('2026-05-02T12:00:00Z');
    const expiresAt = new Date('2026-05-02T11:00:00Z');
    findMany
      .mockResolvedValueOnce([{ id: 'sess1', expiresAt, userDiscordId: 'u1' }]) // expired
      .mockResolvedValueOnce([]); // none old-revoked
    updateMany.mockResolvedValue({ count: 1 });

    const r = await cleanupExpiredDevSessions(now);

    expect(r.expired).toBe(1);
    expect(r.hardDeleted).toBe(0);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'sess1', revokedAt: null },
      data: { revokedAt: expiresAt },
    });
    expect(auditCalls.find(a => a.action === 'DEV_SESSION_AUTO_REVOKED')).toBeDefined();
  });

  it('loescht revoked Sessions hart, wenn aelter als Retention', async () => {
    const now = new Date('2026-05-02T12:00:00Z');
    const oldRevoked = { id: 'old1', userDiscordId: 'u2', revokedAt: new Date('2026-04-20T00:00:00Z') };
    findMany
      .mockResolvedValueOnce([])             // expired
      .mockResolvedValueOnce([oldRevoked]);  // old-revoked
    deleteOne.mockResolvedValue({});

    const r = await cleanupExpiredDevSessions(now);

    expect(r.hardDeleted).toBe(1);
    expect(deleteOne).toHaveBeenCalledWith({ where: { id: 'old1' } });
    expect(auditCalls.find(a => a.action === 'DEV_SESSION_HARD_DELETED')).toBeDefined();
  });
});

describe('maybeAutoExtendDevSession', () => {
  const now = new Date('2026-05-02T12:00:00Z');
  const createdAt = new Date(now.getTime() - 30 * 60 * 1000); // 30min alt

  it('extendet nicht, wenn ausserhalb Threshold', async () => {
    const expiresAt = new Date(now.getTime() + SESSION_AUTO_EXTEND_THRESHOLD_MS + 60_000);
    const r = await maybeAutoExtendDevSession({ id: 's1', createdAt, expiresAt, userDiscordId: 'u1' }, now);
    expect(r.extended).toBe(false);
    expect(r.reason).toBe('no_window');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('extendet um STEP, wenn innerhalb Threshold', async () => {
    const expiresAt = new Date(now.getTime() + 60_000); // 1min uebrig
    updateMany.mockResolvedValue({ count: 1 });
    const r = await maybeAutoExtendDevSession({ id: 's2', createdAt, expiresAt, userDiscordId: 'u1' }, now);
    expect(r.extended).toBe(true);
    expect(r.newExpiresAt.getTime()).toBe(expiresAt.getTime() + SESSION_AUTO_EXTEND_STEP_MS);
    expect(auditCalls.find(a => a.action === 'DEV_SESSION_EXTENDED')).toBeDefined();
  });

  it('cappt auf createdAt + MAX_LIFETIME', async () => {
    // 5min unter dem Cap geboren -> hardCap = now + 5min, step (30min) wuerde drueber gehen
    const ancientCreated = new Date(now.getTime() - SESSION_MAX_LIFETIME_MS + 5 * 60_000);
    const expiresAt = new Date(now.getTime() + 60_000); // 1min uebrig (innerhalb Threshold)
    updateMany.mockResolvedValue({ count: 1 });
    const r = await maybeAutoExtendDevSession({ id: 's3', createdAt: ancientCreated, expiresAt, userDiscordId: 'u1' }, now);
    expect(r.extended).toBe(true);
    const expectedCap = ancientCreated.getTime() + SESSION_MAX_LIFETIME_MS;
    expect(r.newExpiresAt.getTime()).toBe(expectedCap);
  });

  it('verweigert Extension, wenn schon am Cap', async () => {
    const ancientCreated = new Date(now.getTime() - SESSION_MAX_LIFETIME_MS - 60_000);
    const expiresAt = new Date(ancientCreated.getTime() + SESSION_MAX_LIFETIME_MS); // = Cap
    const r = await maybeAutoExtendDevSession({ id: 's4', createdAt: ancientCreated, expiresAt, userDiscordId: 'u1' }, now);
    expect(r.extended).toBe(false);
    expect(r.reason).toBe('capped');
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('forceRevokeDevSession', () => {
  it('lehnt zu kurze reason ab', async () => {
    const r = await forceRevokeDevSession({
      sessionId: 'x', byUserId: 'u1', byDiscordId: 'd1', reason: 'a',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('reason_too_short');
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('liefert not_found wenn Session fehlt', async () => {
    findUnique.mockResolvedValue(null);
    const r = await forceRevokeDevSession({
      sessionId: 'missing', byUserId: 'u1', byDiscordId: 'd1', reason: 'gueltige begruendung',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('not_found');
  });

  it('lehnt schon revoked ab', async () => {
    findUnique.mockResolvedValue({ id: 's1', userDiscordId: 'u9', revokedAt: new Date(), expiresAt: new Date() });
    const r = await forceRevokeDevSession({
      sessionId: 's1', byUserId: 'u1', byDiscordId: 'd1', reason: 'gueltige begruendung',
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('already_revoked');
  });

  it('revoked + auditiert bei gueltigem Input', async () => {
    findUnique.mockResolvedValue({ id: 's1', userDiscordId: 'u9', revokedAt: null, expiresAt: new Date(Date.now() + 3600_000) });
    updateMany.mockResolvedValue({ count: 1 });
    const r = await forceRevokeDevSession({
      sessionId: 's1', byUserId: 'admin1', byDiscordId: 'discAdmin', reason: 'tab verloren',
    });
    expect(r.ok).toBe(true);
    expect(r.revoked).toBe(1);
    const audit = auditCalls.find(a => a.action === 'DEV_SESSION_FORCE_REVOKED');
    expect(audit).toBeDefined();
  });
});

describe('listActiveDevSessions', () => {
  it('liefert remainingMs und totalLifetimeMs', async () => {
    const now = new Date('2026-05-02T12:00:00Z');
    const createdAt = new Date(now.getTime() - 30 * 60 * 1000);
    const expiresAt = new Date(now.getTime() + 30 * 60 * 1000);
    findMany.mockResolvedValueOnce([{ id: 's1', userDiscordId: 'u1', createdAt, expiresAt, scope: {} }]);
    const rows = await listActiveDevSessions(now);
    expect(rows).toHaveLength(1);
    expect(rows[0].remainingMs).toBe(30 * 60 * 1000);
    expect(rows[0].totalLifetimeMs).toBe(60 * 60 * 1000);
  });
});
