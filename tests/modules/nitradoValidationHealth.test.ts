process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: {} }));

import {
  deleteValidationHealth,
  recordValidationFailure,
  resetValidationHealth,
  sanitizeValidationError,
  type ValidationHealthClient,
} from '../../src/modules/nitrado/validationHealth';
import { asGuildId, asNitradoConnId } from '../../src/types/scope';

interface Row {
  guildId: string;
  nitradoConnId: string;
  failureCount: number;
  lastErrorMessage: string | null;
  lastFailureAt: Date | null;
  lastAlertAt: Date | null;
}

function makeClient() {
  const rows = new Map<string, Row>();
  const key = (guildId: string, nitradoConnId: string) => `${guildId}:${nitradoConnId}`;

  const client: ValidationHealthClient = {
    nitradoValidationHealth: {
      upsert: async (args: unknown) => {
        const a = args as {
          where: { guildId_nitradoConnId: { guildId: string; nitradoConnId: string } };
          create: Row;
          update: { failureCount: { increment: number }; lastErrorMessage: string; lastFailureAt: Date };
        };
        const scope = a.where.guildId_nitradoConnId;
        const k = key(scope.guildId, scope.nitradoConnId);
        const existing = rows.get(k);
        const row: Row = existing
          ? {
              ...existing,
              failureCount: existing.failureCount + a.update.failureCount.increment,
              lastErrorMessage: a.update.lastErrorMessage,
              lastFailureAt: a.update.lastFailureAt,
            }
          : { ...a.create };
        rows.set(k, row);
        return { failureCount: row.failureCount, lastAlertAt: row.lastAlertAt };
      },
      updateMany: async (args: unknown) => {
        const a = args as {
          where: {
            guildId: string;
            nitradoConnId: string;
            failureCount?: { gte: number };
            lastAlertAt?: null;
          };
          data: Partial<Row>;
        };
        const k = key(a.where.guildId, a.where.nitradoConnId);
        const row = rows.get(k);
        if (!row) return { count: 0 };
        if (a.where.failureCount && row.failureCount < a.where.failureCount.gte) return { count: 0 };
        if (a.where.lastAlertAt === null && row.lastAlertAt !== null) return { count: 0 };
        rows.set(k, { ...row, ...a.data });
        return { count: 1 };
      },
      deleteMany: async (args: unknown) => {
        const a = args as { where: { guildId: string; nitradoConnId: string } };
        const removed = rows.delete(key(a.where.guildId, a.where.nitradoConnId));
        return { count: removed ? 1 : 0 };
      },
    },
  };

  return { client, rows, key };
}

const guildId = asGuildId('123456789012345678');
const connId = asNitradoConnId('c123456789012345678901234');
const t1 = new Date('2026-08-14T08:00:00Z');

describe('NIT-001 validation health', () => {
  it('redigiert Secrets und begrenzt Diagnosetext', () => {
    const raw = `401 Bearer abc.def.ghi token=super-secret ${'a'.repeat(80)}\nnext`;
    const safe = sanitizeValidationError(raw);
    expect(safe).not.toContain('abc.def.ghi');
    expect(safe).not.toContain('super-secret');
    expect(safe).toContain('[REDACTED]');
    expect(safe).not.toContain('\n');
    expect(safe.length).toBeLessThanOrEqual(500);
  });

  it('warnt erst beim dritten Fehler und nur einmal pro Fehlerstreak', async () => {
    const { client, rows, key } = makeClient();

    const first = await recordValidationFailure(guildId, connId, 'timeout', t1, client);
    const second = await recordValidationFailure(guildId, connId, 'timeout', new Date(t1.getTime() + 1_000), client);
    const third = await recordValidationFailure(guildId, connId, 'timeout', new Date(t1.getTime() + 2_000), client);
    const fourth = await recordValidationFailure(guildId, connId, 'timeout', new Date(t1.getTime() + 3_000), client);

    expect(first).toMatchObject({ failureCount: 1, shouldAlert: false });
    expect(second).toMatchObject({ failureCount: 2, shouldAlert: false });
    expect(third).toMatchObject({ failureCount: 3, shouldAlert: true });
    expect(fourth).toMatchObject({ failureCount: 4, shouldAlert: false });
    expect(rows.get(key(guildId, connId))?.lastAlertAt).not.toBeNull();
  });

  it('Reset startet einen neuen Streak und erlaubt spaeter erneut genau einen Alert', async () => {
    const { client, rows, key } = makeClient();
    for (let i = 0; i < 3; i++) {
      await recordValidationFailure(guildId, connId, 'temporary', new Date(t1.getTime() + i), client);
    }

    await resetValidationHealth(guildId, connId, client);
    expect(rows.get(key(guildId, connId))).toMatchObject({
      failureCount: 0,
      lastErrorMessage: null,
      lastFailureAt: null,
      lastAlertAt: null,
    });

    const alerts: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await recordValidationFailure(guildId, connId, 'temporary', new Date(t1.getTime() + 10 + i), client);
      alerts.push(result.shouldAlert);
    }
    expect(alerts).toEqual([false, false, true]);
  });

  it('trennt den Diagnosezustand strikt nach Guild+Connection', async () => {
    const { client, rows, key } = makeClient();
    const otherGuild = asGuildId('223456789012345678');
    await recordValidationFailure(guildId, connId, 'one', t1, client);
    await recordValidationFailure(otherGuild, connId, 'two', t1, client);

    expect(rows.get(key(guildId, connId))?.failureCount).toBe(1);
    expect(rows.get(key(otherGuild, connId))?.failureCount).toBe(1);
  });

  it('loescht Diagnosezustand beim Entfernen eines Slots', async () => {
    const { client, rows, key } = makeClient();
    await recordValidationFailure(guildId, connId, 'temporary', t1, client);
    await deleteValidationHealth(guildId, connId, client);
    expect(rows.has(key(guildId, connId))).toBe(false);
  });
});
