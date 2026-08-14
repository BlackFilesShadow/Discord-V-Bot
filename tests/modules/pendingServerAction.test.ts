import {
  PENDING_SERVER_ACTION_TTL_MS,
  consumePendingServerAction,
  createPendingServerAction,
  deleteExpiredPendingServerActions,
  type PendingServerActionClient,
  type PendingServerActionRow,
} from '../../src/modules/nitrado/pendingServerAction';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

function makeClient() {
  const rows = new Map<string, PendingServerActionRow>();
  let seq = 0;

  const client: PendingServerActionClient = {
    pendingServerAction: {
      async create({ data }) {
        const row: PendingServerActionRow = {
          id: `psa-${++seq}`,
          guildId: String(data.guildId),
          nitradoConnId: String(data.nitradoConnId),
          actorDiscordId: String(data.actorDiscordId),
          actionType: String(data.actionType),
          payload: data.payload ?? {},
          status: 'PENDING',
          expiresAt: data.expiresAt as Date,
          consumedAt: null,
          createdAt: new Date('2026-08-14T11:00:00.000Z'),
        };
        rows.set(row.id, row);
        return row;
      },
      async findFirst({ where }) {
        const wanted = rows.get(String(where.id));
        if (!wanted) return null;
        if (where.guildId !== wanted.guildId || where.actorDiscordId !== wanted.actorDiscordId) return null;
        if (where.status !== wanted.status) return null;
        if (where.consumedAt instanceof Date && wanted.consumedAt?.getTime() !== where.consumedAt.getTime()) return null;
        return wanted;
      },
      async updateMany({ where, data }) {
        const wanted = rows.get(String(where.id));
        if (!wanted) return { count: 0 };
        const expiry = where.expiresAt as { gt?: Date } | undefined;
        if (where.guildId !== wanted.guildId || where.actorDiscordId !== wanted.actorDiscordId) return { count: 0 };
        if (where.nitradoConnId && where.nitradoConnId !== wanted.nitradoConnId) return { count: 0 };
        if (where.status !== wanted.status) return { count: 0 };
        if (expiry?.gt && wanted.expiresAt <= expiry.gt) return { count: 0 };
        if (data.status === 'CONSUMED') wanted.status = 'CONSUMED';
        if (data.consumedAt instanceof Date) wanted.consumedAt = data.consumedAt;
        rows.set(wanted.id, wanted);
        return { count: 1 };
      },
      async deleteMany() {
        const count = rows.size;
        rows.clear();
        return { count };
      },
    },
  };

  return { client, rows };
}

const guildId = asGuildId('123456789012345678');
const nitradoConnId = asNitradoConnId('conn-1');
const actorDiscordId = asUserDiscordId('234567890123456789');
const now = new Date('2026-08-14T11:00:00.000Z');

describe('PendingServerAction / SCOPE-003', () => {
  it('begrenzt die Lebensdauer hart auf hoechstens fuenf Minuten', async () => {
    const { client } = makeClient();
    const row = await createPendingServerAction(client, {
      guildId,
      nitradoConnId,
      actorDiscordId,
      actionType: 'ECONOMY_MUTATION',
      payload: { amount: '100' },
      now,
    });
    expect(row.expiresAt.getTime() - now.getTime()).toBe(PENDING_SERVER_ACTION_TTL_MS);

    await expect(createPendingServerAction(client, {
      guildId,
      nitradoConnId,
      actorDiscordId,
      actionType: 'ECONOMY_MUTATION',
      now,
      ttlMs: PENDING_SERVER_ACTION_TTL_MS + 1,
    })).rejects.toThrow(/TTL/);
  });

  it('verweigert Secrets rekursiv im Payload', async () => {
    const { client } = makeClient();
    await expect(createPendingServerAction(client, {
      guildId,
      nitradoConnId,
      actorDiscordId,
      actionType: 'SAFE_ACTION',
      payload: { nested: { authorization: 'Bearer secret' } },
      now,
    })).rejects.toThrow(/keine Secrets/);
  });

  it('kann atomar nur einmal konsumiert werden und bindet Guild+Actor+Server', async () => {
    const { client } = makeClient();
    const row = await createPendingServerAction(client, {
      guildId,
      nitradoConnId,
      actorDiscordId,
      actionType: 'SAFE_ACTION',
      payload: { selection: 'x' },
      now,
    });

    const first = await consumePendingServerAction(client, {
      id: row.id,
      guildId,
      nitradoConnId,
      actorDiscordId,
      now: new Date(now.getTime() + 1_000),
    });
    const second = await consumePendingServerAction(client, {
      id: row.id,
      guildId,
      nitradoConnId,
      actorDiscordId,
      now: new Date(now.getTime() + 2_000),
    });

    expect(first?.status).toBe('CONSUMED');
    expect(second).toBeNull();
  });

  it('liefert abgelaufene Aktionen nicht aus und Cleanup ist definiert', async () => {
    const { client, rows } = makeClient();
    const row = await createPendingServerAction(client, {
      guildId,
      nitradoConnId,
      actorDiscordId,
      actionType: 'SAFE_ACTION',
      now,
      ttlMs: 1_000,
    });

    const consumed = await consumePendingServerAction(client, {
      id: row.id,
      guildId,
      nitradoConnId,
      actorDiscordId,
      now: new Date(now.getTime() + 2_000),
    });
    expect(consumed).toBeNull();

    expect(await deleteExpiredPendingServerActions(client, new Date(now.getTime() + 10_000))).toBe(1);
    expect(rows.size).toBe(0);
  });
});
