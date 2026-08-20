import { AuditCategory } from '@prisma/client';
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

const ID = '11111111-1111-4111-8111-111111111111';

describe('Dashboard-1W audit query contract', () => {
  test('limit is strict integer 1..100 with a stable default', () => {
    expect(parseAuditLimit(undefined)).toBe(50);
    expect(parseAuditLimit('1')).toBe(1);
    expect(parseAuditLimit('50')).toBe(50);
    expect(parseAuditLimit('100')).toBe(100);

    for (const bad of ['0', '101', '-1', '1.5', '05', ' 5 ', 'NaN', '', '1e2']) {
      expect(() => parseAuditLimit(bad)).toThrow(AuditQueryValidationError);
    }
    expect(() => parseAuditLimit(['50'])).toThrow(AuditQueryValidationError);
  });

  test('category is an exact Prisma AuditCategory and action is bounded/trimmed', () => {
    expect(parseAuditCategory(undefined)).toBeUndefined();
    expect(parseAuditCategory(AuditCategory.ADMIN)).toBe(AuditCategory.ADMIN);
    expect(() => parseAuditCategory('NOT_REAL')).toThrow(AuditQueryValidationError);
    expect(() => parseAuditCategory(['ADMIN'])).toThrow(AuditQueryValidationError);

    expect(parseAuditAction(undefined)).toBeUndefined();
    expect(parseAuditAction('  PERM_GRANTED  ')).toBe('PERM_GRANTED');
    expect(parseAuditAction('   ')).toBeUndefined();
    expect(() => parseAuditAction('x'.repeat(121))).toThrow(AuditQueryValidationError);
    expect(() => parseAuditAction('BAD\nACTION')).toThrow(AuditQueryValidationError);
  });

  test('cursor round-trips createdAt + id and produces the matching strict tie-breaker', () => {
    const createdAt = new Date('2026-08-20T03:00:00.123Z');
    const token = encodeAuditCursor({ createdAt, id: ID });
    expect(token.startsWith('v1.')).toBe(true);

    const decoded = decodeAuditCursor(token)!;
    expect(decoded.id).toBe(ID);
    expect(decoded.createdAt.toISOString()).toBe(createdAt.toISOString());
    expect(auditCursorFilter(decoded)).toEqual({
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { lt: ID } },
      ],
    });
  });

  test('cursor rejects legacy timestamps, malformed payloads and non-UUID ids', () => {
    expect(decodeAuditCursor(undefined)).toBeUndefined();
    for (const bad of [
      '',
      '2026-08-20T03:00:00.123Z',
      'v0.abc',
      'v1.!not-base64!',
      'v1.e30', // {}
      `v1.${Buffer.from(JSON.stringify({ t: '2026-08-20T03:00:00.123Z', id: 'not-a-uuid' })).toString('base64url')}`,
      `v1.${Buffer.from(JSON.stringify({ t: '2026-08-20T03:00:00Z', id: ID })).toString('base64url')}`,
      `v1.${Buffer.from(JSON.stringify({ t: '2026-08-20T03:00:00.123Z', id: ID, extra: true })).toString('base64url')}`,
    ]) {
      expect(() => decodeAuditCursor(bad)).toThrow(AuditQueryValidationError);
    }
  });
});

describe('Dashboard-1W audit detail redaction', () => {
  test('redacts secrets recursively through objects and arrays', () => {
    expect(redactAuditDetails({
      token: 'super-secret-token',
      nested: {
        password: 'hunter2',
        safe: 'visible',
        rows: [{ authorization: 'Bearer abc.def.ghi' }, { note: 'safe' }],
      },
    })).toEqual({
      token: AUDIT_REDACTED_VALUE,
      nested: {
        password: AUDIT_REDACTED_VALUE,
        safe: 'visible',
        rows: [{ authorization: AUDIT_REDACTED_VALUE }, { note: 'safe' }],
      },
    });
  });

  test('redacts legacy top-level strings/arrays instead of returning them raw', () => {
    expect(redactAuditDetails('Bearer abc.def.ghi')).toBe(`Bearer ${AUDIT_REDACTED_VALUE}`);
    expect(redactAuditDetails('token=abc123')).toBe(`token=${AUDIT_REDACTED_VALUE}`);
    expect(redactAuditDetails(['connect 10.1.2.3:2302', { cookie: 'sid=secret' }])).toEqual([
      'connect [IP]',
      { cookie: AUDIT_REDACTED_VALUE },
    ]);
  });

  test('redacts authorization/cookie headers and JWT-looking free text', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature12345';
    expect(redactAuditDetails('Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='))
      .toBe(`Authorization: Basic ${AUDIT_REDACTED_VALUE}`);
    expect(redactAuditDetails('Cookie: session=raw-cookie; theme=dark'))
      .toBe(`Cookie: ${AUDIT_REDACTED_VALUE}`);
    expect(redactAuditDetails(`jwt=${jwt}`)).not.toContain(jwt);
    expect(redactAuditDetails(`raw ${jwt}`)).toBe(`raw ${AUDIT_REDACTED_VALUE}`);
  });
});
