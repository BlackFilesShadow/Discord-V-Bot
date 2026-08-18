import {
  PENDING_SERVER_ACTION_EXECUTION_LEASE_MS,
  PENDING_SERVER_ACTION_TTL_MS,
  claimPendingServerAction,
  completePendingServerAction,
  createPendingServerAction,
  deleteExpiredPendingServerActions,
  releasePendingServerActionClaim,
  type PendingServerActionClient,
  type PendingServerActionRow,
} from '../../src/modules/nitrado/pendingServerAction';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

function matchesValue(actual: unknown, expected: unknown): boolean {
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    const condition = expected as { gt?: Date; lte?: Date; lt?: Date };
    if (actual instanceof Date) {
      if (condition.gt && !(actual > condition.gt)) return false;
      if (condition.lte && !(actual <= condition.lte)) return false;
      if (condition.lt && !(actual < condition.lt)) return false;
      return true;
    }
  }
  return actual === expected;
}

function matchesWhere(row: PendingServerActionRow, where: Record<string, unknown>): boolean {
  const or = where.OR as Record<string, unknown>[] | undefined;
  if (or && !or.some(entry => matchesWhere(row, entry))) return false;

  for (const [key, expected] of Object.entries(where)) {
    if (key === 'OR') continue;
    const actual = row[key as keyof PendingServerActionRow];
    if (!matchesValue(actual, expected)) return false;
  }
  return true;
}

function makeClient() {
  const rows = new Map<string, PendingServerActionRow>();

  const client: PendingServerActionClient = {
    pendingServerAction: {
      async create({ data }) {
        const row: PendingServerActionRow = {
          id: String(data.id),
          guildId: String(data.guildId),
          nitradoConnId: String(data.nitradoConnId),
          actorDiscordId: String(data.actorDiscordId),
          actionType: String(data.actionType),
          payload: data.payload ?? {},
          status: 'PENDING',
          expiresAt: data.expiresAt as Date,
          claimToken: null,
          claimedAt: null,
          consumedAt: null,
          createdAt: new Date('2026-08-14T11:00:00.000Z'),
        };
        rows.set(row.id, row);
        return { ...row };
      },
      async findFirst({ where }) {
        const row = [...rows.values()].find(candidate => matchesWhere(candidate, where));
        return row ? { ...row } : null;
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of rows.values()) {
          if (!matchesWhere(row, where)) continue;
          Object.assign(row, data);
          rows.set(row.id, row);
          count += 1;
        }
        return { count };
      },
      async deleteMany({ where }) {
        let count = 0;
        for (const [id, row] of [...rows.entries()]) {
          if (!matchesWhere(row, where)) continue;
          rows.delete(id);
          count += 1;
        }
        return { count };
      },
    },
  };

  return { client, rows };
}

const guildId = asGuildId('123456789012345678');
const nitradoConnId = asNitradoConnId('clx1234567890123456789012');
const actorDiscordId = asUserDiscordId('234567890123456789');
const now = new Date('2026-08-14T11:00:00.000Z');

describe('PendingServerAction / SCOPE-003 + Nitrado-1E', () => {
  it('erzeugt kryptografisch zufaellige UUIDv4-Action-IDs', async () => {
    const { client } = makeClient();
    const first = await createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'SAFE_ACTION', now,
    });
    const second = await createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'SAFE_ACTION', now,
    });

    const uuidV4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(first.id).toMatch(uuidV4);
    expect(second.id).toMatch(uuidV4);
    expect(first.id).not.toBe(second.id);
  });

  it('begrenzt die Confirmation-Lebensdauer hart auf hoechstens fuenf Minuten', async () => {
    const { client } = makeClient();
    const row = await createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'ECONOMY_MUTATION', payload: { amount: '100' }, now,
    });
    expect(row.expiresAt.getTime() - now.getTime()).toBe(PENDING_SERVER_ACTION_TTL_MS);

    await expect(createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'ECONOMY_MUTATION', now,
      ttlMs: PENDING_SERVER_ACTION_TTL_MS + 1,
    })).rejects.toThrow(/TTL/);
  });

  it('verweigert Secrets rekursiv im Payload', async () => {
    const { client } = makeClient();
    await expect(createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'SAFE_ACTION',
      payload: { nested: { authorization: 'Bearer secret' } }, now,
    })).rejects.toThrow(/keine Secrets/);
  });

  it('claimt atomar nur einmal und konsumiert erst nach fenced complete', async () => {
    const { client, rows } = makeClient();
    const row = await createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'SAFE_ACTION', payload: { selection: 'x' }, now,
    });

    const first = await claimPendingServerAction(client, {
      id: row.id, guildId, nitradoConnId, actorDiscordId, now: new Date(now.getTime() + 1_000),
    });
    const concurrent = await claimPendingServerAction(client, {
      id: row.id, guildId, nitradoConnId, actorDiscordId, now: new Date(now.getTime() + 2_000),
    });

    expect(first?.status).toBe('RUNNING');
    expect(first?.claimToken).toBeTruthy();
    expect(concurrent).toBeNull();
    expect(rows.get(row.id)?.status).toBe('RUNNING');

    expect(await completePendingServerAction(client, {
      id: row.id, guildId, actorDiscordId, claimToken: first!.claimToken,
      now: new Date(now.getTime() + 3_000),
    })).toBe(true);
    expect(rows.get(row.id)?.status).toBe('CONSUMED');
  });

  it('release behaelt die bestaetigte Action recoverbar, auch nach Ablauf der Confirmation-TTL', async () => {
    const { client } = makeClient();
    const row = await createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'SAFE_ACTION', now, ttlMs: 1_000,
    });
    const first = await claimPendingServerAction(client, {
      id: row.id, guildId, actorDiscordId, now: new Date(now.getTime() + 500),
    });
    expect(first).not.toBeNull();

    expect(await releasePendingServerActionClaim(client, {
      id: row.id, guildId, actorDiscordId, claimToken: first!.claimToken,
    })).toBe(true);

    const retry = await claimPendingServerAction(client, {
      id: row.id, guildId, actorDiscordId, now: new Date(now.getTime() + 10_000),
    });
    expect(retry).not.toBeNull();
    expect(retry!.claimToken).not.toBe(first!.claimToken);
  });

  it('reclaimt einen stale Lease und verhindert Complete mit dem alten Claim-Token', async () => {
    const { client } = makeClient();
    const row = await createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'SAFE_ACTION', now,
    });
    const first = await claimPendingServerAction(client, {
      id: row.id, guildId, actorDiscordId, now: new Date(now.getTime() + 1_000),
    });
    expect(first).not.toBeNull();

    const reclaimedAt = new Date(now.getTime() + 1_000 + PENDING_SERVER_ACTION_EXECUTION_LEASE_MS + 1);
    const second = await claimPendingServerAction(client, {
      id: row.id, guildId, actorDiscordId, now: reclaimedAt,
    });
    expect(second).not.toBeNull();
    expect(second!.claimToken).not.toBe(first!.claimToken);

    expect(await completePendingServerAction(client, {
      id: row.id, guildId, actorDiscordId, claimToken: first!.claimToken, now: reclaimedAt,
    })).toBe(false);
    expect(await completePendingServerAction(client, {
      id: row.id, guildId, actorDiscordId, claimToken: second!.claimToken, now: reclaimedAt,
    })).toBe(true);
  });

  it('loescht abgelaufene unbestaetigte Actions, aber keine frisch bestaetigte RUNNING-Action', async () => {
    const { client, rows } = makeClient();
    const pending = await createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'SAFE_ACTION', now, ttlMs: 1_000,
    });
    const running = await createPendingServerAction(client, {
      guildId, nitradoConnId, actorDiscordId, actionType: 'SAFE_ACTION', now, ttlMs: 1_000,
    });
    await claimPendingServerAction(client, {
      id: running.id, guildId, actorDiscordId, now: new Date(now.getTime() + 500),
    });

    expect(await deleteExpiredPendingServerActions(client, new Date(now.getTime() + 10_000))).toBe(1);
    expect(rows.has(pending.id)).toBe(false);
    expect(rows.get(running.id)?.status).toBe('RUNNING');
  });
});
