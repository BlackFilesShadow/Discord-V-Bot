process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GUILD_ID = '123456789012345678';
const ACTOR_ID = '876543210987654321';
const findMany = jest.fn();
const groupBy = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    auditLog: {
      findMany: (...args: unknown[]) => findMany(...args),
      groupBy: (...args: unknown[]) => groupBy(...args),
    },
  },
}));

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireGuildPermission: (_perm: string) => (
    req: { auth?: unknown; guildScope?: unknown },
    _res: unknown,
    next: () => void,
  ) => {
    req.auth = { userId: 'user-internal-id', discordId: ACTOR_ID, role: 'USER' };
    req.guildScope = {
      guildId: GUILD_ID,
      actorDiscordId: ACTOR_ID,
      isOwner: false,
      permissions: ['dashboard.access'],
    };
    next();
  },
}));

import express from 'express';
import request from 'supertest';
import { AuditCategory } from '@prisma/client';
import { auditRouter } from '../../src/dashboard/routes/v2/audit';
import {
  AuditQueryValidationError,
  auditCursorFilter,
  decodeAuditCursor,
  encodeAuditCursor,
  parseAuditAction,
  parseAuditCategory,
  parseAuditLimit,
} from '../../src/dashboard/routes/v2/auditContract';
import { AUDIT_REDACTED_VALUE, redactAuditDetails } from '../../src/utils/auditRedaction';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/v2/guilds/:guildId/audit', auditRouter);
  return instance;
}

const SAME_TIME = new Date('2026-08-20T04:00:00.000Z');
const ID_HIGH = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const ID_MID = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const ID_LOW = '11111111-1111-4111-8111-111111111111';

function row(id: string, createdAt = SAME_TIME, details: unknown = { ok: true }) {
  return {
    id,
    action: 'TICKET_TEMPLATE_UPDATE',
    category: AuditCategory.TICKET,
    createdAt,
    actor: { discordId: ACTOR_ID, username: 'owner' },
    target: null,
    channelId: null,
    details,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  findMany.mockResolvedValue([]);
  groupBy.mockResolvedValue([]);
});

describe('Dashboard-1W audit query contract', () => {
  it('accepts only strict integer limits from 1 through 100', () => {
    expect(parseAuditLimit(undefined)).toBe(50);
    expect(parseAuditLimit('1')).toBe(1);
    expect(parseAuditLimit('100')).toBe(100);
    for (const invalid of ['0', '101', '1.5', '-1', '+1', '01', 'NaN', '', ['50']]) {
      expect(() => parseAuditLimit(invalid)).toThrow(AuditQueryValidationError);
    }
  });

  it('validates category and action filters fail-closed', () => {
    expect(parseAuditCategory(AuditCategory.TICKET)).toBe(AuditCategory.TICKET);
    expect(() => parseAuditCategory('NOT_A_CATEGORY')).toThrow(AuditQueryValidationError);
    expect(() => parseAuditCategory([AuditCategory.TICKET])).toThrow(AuditQueryValidationError);
    expect(parseAuditAction('  TICKET_  ')).toBe('TICKET_');
    expect(parseAuditAction('   ')).toBeUndefined();
    expect(() => parseAuditAction('x'.repeat(121))).toThrow(AuditQueryValidationError);
    expect(() => parseAuditAction('ok\nno')).toThrow(AuditQueryValidationError);
  });

  it('round-trips a versioned opaque cursor and builds the exact tie-breaker window', () => {
    const token = encodeAuditCursor({ createdAt: SAME_TIME, id: ID_MID });
    expect(token.startsWith('v1.')).toBe(true);
    const decoded = decodeAuditCursor(token)!;
    expect(decoded.createdAt.toISOString()).toBe(SAME_TIME.toISOString());
    expect(decoded.id).toBe(ID_MID);
    expect(auditCursorFilter(decoded)).toEqual({
      OR: [
        { createdAt: { lt: SAME_TIME } },
        { createdAt: SAME_TIME, id: { lt: ID_MID } },
      ],
    });
  });

  it('rejects malformed, ambiguous and overlong cursors', () => {
    for (const invalid of [
      '',
      'v2.abc',
      'v1.!bad',
      'v1.' + 'a'.repeat(600),
      ['v1.abc'],
      'v1.' + Buffer.from(JSON.stringify({ t: SAME_TIME.toISOString() }), 'utf8').toString('base64url'),
      'v1.' + Buffer.from(JSON.stringify({ t: SAME_TIME.toISOString(), id: ID_MID, extra: true }), 'utf8').toString('base64url'),
    ]) {
      expect(() => decodeAuditCursor(invalid)).toThrow(AuditQueryValidationError);
    }
  });

  it('uses guild scope, deterministic order, limit+1 and emits a server cursor without losing equal timestamps', async () => {
    findMany.mockResolvedValue([
      row(ID_HIGH),
      row(ID_MID),
      row(ID_LOW),
    ]);

    const first = await request(app())
      .get(`/api/v2/guilds/${GUILD_ID}/audit`)
      .query({ limit: '2', category: AuditCategory.TICKET, action: 'TICKET_' });

    expect(first.status).toBe(200);
    expect(first.body.entries.map((entry: { id: string }) => entry.id)).toEqual([ID_HIGH, ID_MID]);
    expect(first.body.hasMore).toBe(true);
    expect(typeof first.body.nextCursor).toBe('string');
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: GUILD_ID,
        category: AuditCategory.TICKET,
        action: { contains: 'TICKET_', mode: 'insensitive' },
      }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 3,
    }));

    findMany.mockResolvedValue([row(ID_LOW)]);
    const second = await request(app())
      .get(`/api/v2/guilds/${GUILD_ID}/audit`)
      .query({ limit: '2', cursor: first.body.nextCursor });

    expect(second.status).toBe(200);
    expect(second.body.entries.map((entry: { id: string }) => entry.id)).toEqual([ID_LOW]);
    expect(second.body.hasMore).toBe(false);
    expect(second.body.nextCursor).toBeNull();
    const secondWhere = findMany.mock.calls[1][0].where;
    expect(secondWhere.guildId).toBe(GUILD_ID);
    expect(secondWhere.OR).toEqual([
      { createdAt: { lt: SAME_TIME } },
      { createdAt: SAME_TIME, id: { lt: ID_MID } },
    ]);
  });

  it('rejects the lossy legacy before cursor and invalid query values before touching Prisma', async () => {
    const legacy = await request(app())
      .get(`/api/v2/guilds/${GUILD_ID}/audit`)
      .query({ before: SAME_TIME.toISOString() });
    expect(legacy.status).toBe(400);

    const decimal = await request(app())
      .get(`/api/v2/guilds/${GUILD_ID}/audit`)
      .query({ limit: '1.5' });
    expect(decimal.status).toBe(400);

    const category = await request(app())
      .get(`/api/v2/guilds/${GUILD_ID}/audit`)
      .query({ category: 'NOPE' });
    expect(category.status).toBe(400);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('returns deterministically sorted category counts inside the exact guild scope', async () => {
    groupBy.mockResolvedValue([
      { category: AuditCategory.TICKET, _count: { _all: 4 } },
      { category: AuditCategory.ADMIN, _count: { _all: 4 } },
      { category: AuditCategory.NITRADO, _count: { _all: 9 } },
    ]);
    const res = await request(app()).get(`/api/v2/guilds/${GUILD_ID}/audit/categories`);
    expect(res.status).toBe(200);
    expect(groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: { guildId: GUILD_ID } }));
    expect(res.body.categories.map((item: { category: string }) => item.category)).toEqual([
      AuditCategory.NITRADO,
      AuditCategory.ADMIN,
      AuditCategory.TICKET,
    ]);
  });
});

describe('Dashboard-1W audit redaction contract', () => {
  it('redacts nested secret keys, Nitrado identifiers and sensitive strings in every JSON shape', () => {
    const value = redactAuditDetails({
      token: 'super-secret-token',
      nested: {
        password: 'pw',
        serviceId: '1234567',
        endpoint: 'connect 192.168.1.10:2302',
        note: 'Authorization: Bearer abc.def.ghi',
      },
      list: ['password=hunter2', '10.20.30.40:2305'],
    }) as Record<string, unknown>;

    expect(value.token).toBe(AUDIT_REDACTED_VALUE);
    expect((value.nested as Record<string, unknown>).password).toBe(AUDIT_REDACTED_VALUE);
    expect((value.nested as Record<string, unknown>).serviceId).toBe(AUDIT_REDACTED_VALUE);
    expect(JSON.stringify(value)).not.toContain('super-secret-token');
    expect(JSON.stringify(value)).not.toContain('hunter2');
    expect(JSON.stringify(value)).not.toContain('192.168.1.10');
    expect(JSON.stringify(value)).not.toContain('10.20.30.40');
    expect(JSON.stringify(value)).not.toContain('abc.def.ghi');
  });

  it('redacts legacy details again on the response path', async () => {
    findMany.mockResolvedValue([
      row(ID_HIGH, SAME_TIME, {
        accessToken: 'raw-token',
        address: '192.168.0.5:2302',
        note: 'password=visible-before-redaction',
      }),
    ]);

    const res = await request(app()).get(`/api/v2/guilds/${GUILD_ID}/audit`);
    expect(res.status).toBe(200);
    const serialized = JSON.stringify(res.body.entries[0].details);
    expect(serialized).not.toContain('raw-token');
    expect(serialized).not.toContain('192.168.0.5');
    expect(serialized).not.toContain('visible-before-redaction');
  });
});
