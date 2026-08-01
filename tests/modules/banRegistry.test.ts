/**
 * Phase 7: Ban-Registry. Beweise: aktiver Bann = nicht aufgehoben + nicht
 * abgelaufen; add/lift/isBanned idempotent; Default-Provider ohne Remote.
 */
import {
  isBanActive, addBan, liftBan, isBanned, localOnlyBanProvider,
  type BanClient, type BanEntry,
} from '../../src/modules/bans/banRegistry';

const SCOPE = { guildId: 'g', nitradoConnId: 'n' };
const now = new Date('2026-08-01T12:00:00Z');

describe('isBanActive', () => {
  it('null/aufgehoben -> false', () => {
    expect(isBanActive(null, now)).toBe(false);
    expect(isBanActive({ active: false, expiresAt: null }, now)).toBe(false);
  });
  it('permanent aktiv -> true', () => {
    expect(isBanActive({ active: true, expiresAt: null }, now)).toBe(true);
  });
  it('abgelaufen -> false', () => {
    expect(isBanActive({ active: true, expiresAt: new Date('2026-08-01T11:00:00Z') }, now)).toBe(false);
  });
  it('noch gueltig -> true', () => {
    expect(isBanActive({ active: true, expiresAt: new Date('2026-08-01T13:00:00Z') }, now)).toBe(true);
  });
});

function makeClient() {
  const rows = new Map<string, BanEntry & { liftedAt: Date | null }>();
  const client: BanClient = {
    serverBanEntry: {
      findUnique: async (args: unknown) => {
        const h = (args as { where: { guildId_nitradoConnId_identityHash: { identityHash: string } } }).where.guildId_nitradoConnId_identityHash.identityHash;
        return rows.get(h) ?? null;
      },
      upsert: async ({ where, create, update }) => {
        const h = (where.guildId_nitradoConnId_identityHash as { identityHash: string }).identityHash;
        if (rows.has(h)) rows.set(h, { ...rows.get(h)!, ...(update as object) } as BanEntry & { liftedAt: Date | null });
        else rows.set(h, { active: create.active as boolean, expiresAt: (create.expiresAt as Date | null) ?? null, liftedAt: null });
        return {};
      },
      updateMany: async ({ where, data }) => {
        const w = where as { identityHash: string; active?: boolean };
        const r = rows.get(w.identityHash);
        if (r && (w.active === undefined || r.active === w.active)) {
          rows.set(w.identityHash, { ...r, ...(data as object) } as BanEntry & { liftedAt: Date | null });
          return { count: 1 };
        }
        return { count: 0 };
      },
    },
  };
  return { client, rows };
}

describe('addBan / isBanned / liftBan', () => {
  it('Bann setzen -> isBanned true', async () => {
    const { client } = makeClient();
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin' });
    expect(await isBanned(client, SCOPE, 'h1', now)).toBe(true);
  });

  it('abgelaufener Bann -> isBanned false', async () => {
    const { client } = makeClient();
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin', expiresAt: new Date('2026-08-01T11:00:00Z') });
    expect(await isBanned(client, SCOPE, 'h1', now)).toBe(false);
  });

  it('liftBan hebt auf', async () => {
    const { client } = makeClient();
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin' });
    expect(await liftBan(client, SCOPE, 'h1', now)).toBe(true);
    expect(await isBanned(client, SCOPE, 'h1', now)).toBe(false);
  });

  it('liftBan auf unbekannt -> false', async () => {
    const { client } = makeClient();
    expect(await liftBan(client, SCOPE, 'nope', now)).toBe(false);
  });
});

describe('localOnlyBanProvider', () => {
  it('meldet keine Remote-Durchsetzung', () => {
    expect(localOnlyBanProvider.capabilities().canApplyRemote).toBe(false);
    expect(localOnlyBanProvider.applyBan).toBeUndefined();
  });
});
