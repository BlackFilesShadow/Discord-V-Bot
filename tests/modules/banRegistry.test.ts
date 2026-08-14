/**
 * Phase 7: Ban-Registry. Beweise: aktiver Bann = nicht aufgehoben + nicht
 * abgelaufen; add/lift/isBanned idempotent; Recovery-Unban bleibt scoped;
 * Default-Provider ohne Remote.
 */
import {
  isBanActive, addBan, liftBan, liftBanById, isBanned, localOnlyBanProvider,
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

type TestBanRow = BanEntry & {
  id: string;
  guildId: string;
  nitradoConnId: string;
  liftedAt: Date | null;
  bannedAt: Date;
  appliedRemotely: boolean;
};

function makeClient() {
  const rows = new Map<string, TestBanRow>();
  const client: BanClient = {
    serverBanEntry: {
      findUnique: async (args: unknown) => {
        const h = (args as { where: { guildId_nitradoConnId_identityHash: { identityHash: string } } }).where.guildId_nitradoConnId_identityHash.identityHash;
        return rows.get(h) ?? null;
      },
      upsert: async ({ where, create, update }) => {
        const h = (where.guildId_nitradoConnId_identityHash as { identityHash: string }).identityHash;
        const existing = rows.get(h);
        if (existing) {
          rows.set(h, { ...existing, ...(update as Partial<TestBanRow>) });
        } else {
          rows.set(h, {
            id: `ban-${h}`,
            guildId: create.guildId as string,
            nitradoConnId: create.nitradoConnId as string,
            active: create.active as boolean,
            expiresAt: (create.expiresAt as Date | null) ?? null,
            liftedAt: null,
            bannedAt: create.bannedAt as Date,
            appliedRemotely: create.appliedRemotely as boolean,
          });
        }
        return {};
      },
      updateMany: async ({ where, data }) => {
        const w = where as { id?: string; guildId?: string; nitradoConnId?: string; identityHash?: string; active?: boolean };
        for (const [hash, row] of rows) {
          if (w.id && row.id !== w.id) continue;
          if (w.guildId && row.guildId !== w.guildId) continue;
          if (w.nitradoConnId && row.nitradoConnId !== w.nitradoConnId) continue;
          if (w.identityHash && hash !== w.identityHash) continue;
          if (w.active !== undefined && row.active !== w.active) continue;
          rows.set(hash, { ...row, ...(data as Partial<TestBanRow>) });
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
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin' }, now);
    expect(await isBanned(client, SCOPE, 'h1', now)).toBe(true);
  });

  it('abgelaufener Bann -> isBanned false', async () => {
    const { client } = makeClient();
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin', expiresAt: new Date('2026-08-01T11:00:00Z') }, now);
    expect(await isBanned(client, SCOPE, 'h1', now)).toBe(false);
  });

  it('liftBan hebt auf', async () => {
    const { client } = makeClient();
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin' }, now);
    expect(await liftBan(client, SCOPE, 'h1', now)).toBe(true);
    expect(await isBanned(client, SCOPE, 'h1', now)).toBe(false);
  });

  it('liftBan auf unbekannt -> false', async () => {
    const { client } = makeClient();
    expect(await liftBan(client, SCOPE, 'nope', now)).toBe(false);
  });

  it('Re-Ban reaktiviert und erneuert bannedAt', async () => {
    const { client, rows } = makeClient();
    const first = new Date('2026-08-01T10:00:00Z');
    const second = new Date('2026-08-01T12:00:00Z');
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin' }, first);
    await liftBan(client, SCOPE, 'h1', new Date('2026-08-01T11:00:00Z'));
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin2' }, second);

    expect(rows.get('h1')?.active).toBe(true);
    expect(rows.get('h1')?.liftedAt).toBeNull();
    expect(rows.get('h1')?.bannedAt).toEqual(second);
  });

  it('liftBanById bleibt strikt auf Guild+Slot begrenzt', async () => {
    const { client, rows } = makeClient();
    await addBan(client, SCOPE, { identityHash: 'h1', bannedByDiscordId: 'admin' }, now);
    const id = rows.get('h1')!.id;

    expect(await liftBanById(client, { guildId: 'other', nitradoConnId: 'n' }, id, now)).toBe(false);
    expect(await liftBanById(client, SCOPE, id, now)).toBe(true);
  });
});

describe('localOnlyBanProvider', () => {
  it('meldet keine Remote-Durchsetzung', () => {
    expect(localOnlyBanProvider.capabilities().canApplyRemote).toBe(false);
    expect(localOnlyBanProvider.applyBan).toBeUndefined();
  });
});
