/**
 * Phase 7: code-first Link-Flow. Beweise: Challenge erzeugt Code; Verify nur mit
 * gueltigem Code; Identitaet nur als Hash gespeichert; doppelte Identitaet
 * abgelehnt; Soft-Unlink.
 */
import {
  createLinkChallenge, verifyByCode, unlinkUser, forceLink, resolveVerifiedUser,
  type LinkClient, type GameIdentityRow,
} from '../../src/modules/linking/linkService';
import { identityHash } from '../../src/modules/linking/identity';

const SECRET = 'sekret';
const SCOPE = { guildId: 'g', nitradoConnId: 'n' };

function makeClient(initial: GameIdentityRow[] = []) {
  const rows = new Map<string, GameIdentityRow>(); // key = userDiscordId
  for (const r of initial) rows.set(r.userDiscordId, { ...r });

  function identityTakenBy(hash: string, exceptUser: string): boolean {
    for (const [u, r] of rows) if (u !== exceptUser && r.identityHash === hash && r.status === 'VERIFIED') return true;
    return false;
  }

  const client: LinkClient = {
    gameIdentityLink: {
      findFirst: async (args: unknown) => {
        const w = (args as { where: { challengeCode?: string; status?: string; userDiscordId?: string; identityHash?: string } }).where;
        for (const r of rows.values()) {
          if (w.challengeCode && r.challengeCode !== w.challengeCode) continue;
          if (w.status && r.status !== w.status) continue;
          if (w.userDiscordId && r.userDiscordId !== w.userDiscordId) continue;
          if (w.identityHash && r.identityHash !== w.identityHash) continue;
          return { ...r };
        }
        return null;
      },
      upsert: async ({ where, create, update }) => {
        const u = (where.guildId_nitradoConnId_userDiscordId as { userDiscordId: string }).userDiscordId;
        const merged = rows.has(u)
          ? { ...rows.get(u)!, ...(update as Partial<GameIdentityRow>) }
          : { ...(create as unknown as GameIdentityRow), userDiscordId: u };
        if (merged.status === 'VERIFIED' && merged.identityHash && identityTakenBy(merged.identityHash, u)) {
          const e = new Error('unique') as Error & { code: string }; e.code = 'P2002'; throw e;
        }
        rows.set(u, merged);
        return {};
      },
      updateMany: async ({ where, data }) => {
        const w = where as { userDiscordId?: string; status?: string | { in: string[] } };
        let count = 0;
        for (const [u, r] of rows) {
          if (w.userDiscordId && u !== w.userDiscordId) continue;
          if (typeof w.status === 'string' && r.status !== w.status) continue;
          if (w.status && typeof w.status === 'object' && !w.status.in.includes(r.status)) continue;
          const next = { ...r, ...(data as Partial<GameIdentityRow>) };
          if (next.status === 'VERIFIED' && next.identityHash && identityTakenBy(next.identityHash, u)) {
            const e = new Error('unique') as Error & { code: string }; e.code = 'P2002'; throw e;
          }
          rows.set(u, next);
          count++;
        }
        return { count };
      },
    },
  };
  return { client, rows };
}

describe('createLinkChallenge', () => {
  it('erzeugt PENDING mit Code + Ablauf', async () => {
    const { client, rows } = makeClient();
    const now = new Date('2026-08-01T12:00:00Z');
    const r = await createLinkChallenge(client, SCOPE, 'u1', now);
    expect(r.code).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    expect(rows.get('u1')!.status).toBe('PENDING');
    expect(rows.get('u1')!.identityHash).toBeNull();
  });
});

describe('verifyByCode', () => {
  it('verifiziert mit richtigem Code und setzt nur den Hash', async () => {
    const { client, rows } = makeClient();
    const now = new Date('2026-08-01T12:00:00Z');
    const { code } = await createLinkChallenge(client, SCOPE, 'u1', now);
    const res = await verifyByCode(client, SCOPE, code, '76561198000000000', SECRET, now);
    expect(res).toEqual({ verified: true, userDiscordId: 'u1' });
    const row = rows.get('u1')!;
    expect(row.status).toBe('VERIFIED');
    expect(row.identityHash).toBe(identityHash('76561198000000000', SECRET));
    expect(row.challengeCode).toBeNull();
  });

  it('lehnt falschen Code ab', async () => {
    const { client } = makeClient();
    await createLinkChallenge(client, SCOPE, 'u1', new Date());
    const res = await verifyByCode(client, SCOPE, 'ZZZZZZZZ', 'x', SECRET, new Date());
    expect(res).toEqual({ verified: false, reason: 'NO_CHALLENGE' });
  });

  it('lehnt abgelaufenen Code ab', async () => {
    const { client } = makeClient();
    const now = new Date('2026-08-01T12:00:00Z');
    const { code } = await createLinkChallenge(client, SCOPE, 'u1', now);
    const later = new Date(now.getTime() + 11 * 60 * 1000);
    const res = await verifyByCode(client, SCOPE, code, 'x', SECRET, later);
    expect(res).toEqual({ verified: false, reason: 'INVALID_OR_EXPIRED' });
  });

  it('lehnt bereits verifizierte Identitaet ab (IDENTITY_TAKEN)', async () => {
    const hash = identityHash('76561198000000000', SECRET);
    const { client } = makeClient([
      { userDiscordId: 'other', identityHash: hash, status: 'VERIFIED', challengeCode: null, challengeExpiresAt: null },
    ]);
    const now = new Date('2026-08-01T12:00:00Z');
    const { code } = await createLinkChallenge(client, SCOPE, 'u1', now);
    const res = await verifyByCode(client, SCOPE, code, '76561198000000000', SECRET, now);
    expect(res).toEqual({ verified: false, reason: 'IDENTITY_TAKEN' });
  });
});

describe('unlinkUser / forceLink', () => {
  it('Soft-Unlink setzt UNLINKED', async () => {
    const { client, rows } = makeClient([
      { userDiscordId: 'u1', identityHash: 'h', status: 'VERIFIED', challengeCode: null, challengeExpiresAt: null },
    ]);
    const ok = await unlinkUser(client, SCOPE, 'u1', new Date());
    expect(ok).toBe(true);
    expect(rows.get('u1')!.status).toBe('UNLINKED');
  });

  it('forceLink verifiziert direkt', async () => {
    const { client, rows } = makeClient();
    const res = await forceLink(client, SCOPE, 'u1', '76561198000000000', SECRET, new Date());
    expect(res).toEqual({ ok: true });
    expect(rows.get('u1')!.status).toBe('VERIFIED');
    expect(rows.get('u1')!.identityHash).toBe(identityHash('76561198000000000', SECRET));
  });

  it('forceLink lehnt fremd-verifizierte Identitaet ab', async () => {
    const hash = identityHash('76561198000000000', SECRET);
    const { client } = makeClient([
      { userDiscordId: 'other', identityHash: hash, status: 'VERIFIED', challengeCode: null, challengeExpiresAt: null },
    ]);
    const res = await forceLink(client, SCOPE, 'u1', '76561198000000000', SECRET, new Date());
    expect(res).toEqual({ ok: false, reason: 'IDENTITY_TAKEN' });
  });
});

describe('resolveVerifiedUser', () => {
  it('loest verifizierte Identitaet zum User auf (per Hash)', async () => {
    const hash = identityHash('76561198000000000', SECRET);
    const { client } = makeClient([
      { userDiscordId: 'u1', identityHash: hash, status: 'VERIFIED', challengeCode: null, challengeExpiresAt: null },
    ]);
    const u = await resolveVerifiedUser(client, SCOPE, '76561198000000000', SECRET);
    expect(u).toBe('u1');
  });

  it('nicht verifiziert / unbekannt -> null', async () => {
    const hash = identityHash('76561198000000000', SECRET);
    const { client } = makeClient([
      { userDiscordId: 'u1', identityHash: hash, status: 'PENDING', challengeCode: 'X', challengeExpiresAt: null },
    ]);
    expect(await resolveVerifiedUser(client, SCOPE, '76561198000000000', SECRET)).toBeNull();
    expect(await resolveVerifiedUser(client, SCOPE, 'unbekannt', SECRET)).toBeNull();
  });
});
