import { randomUUID } from 'node:crypto';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';

/** Unbestaetigte Step-Up-Actions leben hoechstens fuenf Minuten. */
export const PENDING_SERVER_ACTION_TTL_MS = 5 * 60 * 1000;
/** Ein einzelner Confirm-Handler besitzt den Ausfuehrungs-Claim maximal zwei Minuten. */
export const PENDING_SERVER_ACTION_EXECUTION_LEASE_MS = 2 * 60 * 1000;
/** Bestaetigte, aber nie finalisierte Actions bleiben fuer Recovery sieben Tage erhalten. */
export const PENDING_SERVER_ACTION_RECOVERY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type PendingServerActionStatus = 'PENDING' | 'RUNNING' | 'CONSUMED';

export interface PendingServerActionRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  actorDiscordId: string;
  actionType: string;
  payload: unknown;
  status: PendingServerActionStatus;
  expiresAt: Date;
  claimToken: string | null;
  claimedAt: Date | null;
  consumedAt: Date | null;
  createdAt: Date;
}

export type PendingServerActionClaim = PendingServerActionRow & {
  status: 'RUNNING';
  claimToken: string;
  claimedAt: Date;
};

interface PendingServerActionDelegate {
  create(args: { data: Record<string, unknown> }): Promise<PendingServerActionRow>;
  findFirst(args: { where: Record<string, unknown> }): Promise<PendingServerActionRow | null>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  deleteMany(args: { where: Record<string, unknown> }): Promise<{ count: number }>;
}

export interface PendingServerActionClient {
  pendingServerAction: PendingServerActionDelegate;
}

const FORBIDDEN_KEY = /(?:^|_)(?:token|secret|password|authorization|api[_-]?key|encryptedtoken)(?:$|_)/i;

function assertPayloadContainsNoSecrets(value: unknown, path = 'payload', seen = new Set<object>()): void {
  if (value === null || value === undefined) return;
  if (typeof value !== 'object') return;
  if (seen.has(value as object)) return;
  seen.add(value as object);

  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPayloadContainsNoSecrets(entry, `${path}[${index}]`, seen));
    return;
  }

  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY.test(key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`))) {
      throw new Error(`PendingServerAction darf keine Secrets enthalten (${path}.${key}).`);
    }
    assertPayloadContainsNoSecrets(nested, `${path}.${key}`, seen);
  }
}

export async function createPendingServerAction(
  client: PendingServerActionClient,
  args: {
    guildId: GuildId;
    nitradoConnId: NitradoConnId;
    actorDiscordId: UserDiscordId;
    actionType: string;
    payload?: Record<string, unknown>;
    now?: Date;
    ttlMs?: number;
  },
): Promise<PendingServerActionRow> {
  const now = args.now ?? new Date();
  const ttlMs = args.ttlMs ?? PENDING_SERVER_ACTION_TTL_MS;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ttlMs > PENDING_SERVER_ACTION_TTL_MS) {
    throw new Error(`PendingServerAction TTL muss >0 und <=${PENDING_SERVER_ACTION_TTL_MS}ms sein.`);
  }
  const actionType = args.actionType.trim();
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(actionType)) {
    throw new Error('PendingServerAction actionType ist ungueltig.');
  }
  const payload = args.payload ?? {};
  assertPayloadContainsNoSecrets(payload);

  return client.pendingServerAction.create({
    data: {
      id: randomUUID(),
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      actorDiscordId: args.actorDiscordId,
      actionType,
      payload,
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + ttlMs),
      claimToken: null,
      claimedAt: null,
      consumedAt: null,
    },
  });
}

function claimScopeWhere(args: {
  id: string;
  guildId: GuildId;
  actorDiscordId: UserDiscordId;
  nitradoConnId?: NitradoConnId;
}): Record<string, unknown> {
  const where: Record<string, unknown> = {
    id: args.id,
    guildId: args.guildId,
    actorDiscordId: args.actorDiscordId,
  };
  if (args.nitradoConnId) where.nitradoConnId = args.nitradoConnId;
  return where;
}

/**
 * Lease-basierter Ausfuehrungs-Claim.
 *
 * - PENDING darf nur vor expiresAt erstmalig bestaetigt werden.
 * - Nach erfolgreicher Bestaetigung bleibt die Action RUNNING. Ein Prozesscrash
 *   verliert sie deshalb nicht; nach Lease-Ablauf oder explizitem Release darf
 *   derselbe gebundene Actor sie erneut claimen, auch wenn expiresAt inzwischen
 *   abgelaufen ist.
 * - CONSUMED wird hier bewusst NIE gesetzt.
 */
export async function claimPendingServerAction(
  client: PendingServerActionClient,
  args: {
    id: string;
    guildId: GuildId;
    actorDiscordId: UserDiscordId;
    nitradoConnId?: NitradoConnId;
    now?: Date;
    leaseMs?: number;
  },
): Promise<PendingServerActionClaim | null> {
  const now = args.now ?? new Date();
  const leaseMs = args.leaseMs ?? PENDING_SERVER_ACTION_EXECUTION_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > PENDING_SERVER_ACTION_TTL_MS) {
    throw new Error(`PendingServerAction Lease muss >0 und <=${PENDING_SERVER_ACTION_TTL_MS}ms sein.`);
  }

  const claimToken = randomUUID();
  const scopeWhere = claimScopeWhere(args);
  let claimed = await client.pendingServerAction.updateMany({
    where: {
      ...scopeWhere,
      status: 'PENDING',
      expiresAt: { gt: now },
    },
    data: {
      status: 'RUNNING',
      claimToken,
      claimedAt: now,
    },
  });

  if (claimed.count !== 1) {
    const staleBefore = new Date(now.getTime() - leaseMs);
    claimed = await client.pendingServerAction.updateMany({
      where: {
        ...scopeWhere,
        status: 'RUNNING',
        OR: [
          { claimToken: null },
          { claimedAt: null },
          { claimedAt: { lte: staleBefore } },
        ],
      },
      data: { claimToken, claimedAt: now },
    });
  }
  if (claimed.count !== 1) return null;

  const row = await client.pendingServerAction.findFirst({
    where: {
      ...scopeWhere,
      status: 'RUNNING',
      claimToken,
      claimedAt: now,
    },
  });
  if (!row || row.status !== 'RUNNING' || row.claimToken !== claimToken || !row.claimedAt) return null;
  return row as PendingServerActionClaim;
}

/** Finalisiert ausschliesslich den aktuell besessenen Claim. */
export async function completePendingServerAction(
  client: PendingServerActionClient,
  args: {
    id: string;
    guildId: GuildId;
    actorDiscordId: UserDiscordId;
    claimToken: string;
    now?: Date;
  },
): Promise<boolean> {
  const now = args.now ?? new Date();
  const result = await client.pendingServerAction.updateMany({
    where: {
      id: args.id,
      guildId: args.guildId,
      actorDiscordId: args.actorDiscordId,
      status: 'RUNNING',
      claimToken: args.claimToken,
    },
    data: {
      status: 'CONSUMED',
      consumedAt: now,
      claimToken: null,
      claimedAt: null,
    },
  });
  return result.count === 1;
}

/**
 * Gibt nach einem unerwarteten/transienten Fehler nur den Lease frei. Der
 * bestaetigte RUNNING-Zustand bleibt bestehen und kann sicher erneut geclaimt
 * werden; die urspruengliche Confirmation-TTL wird nicht wieder angewandt.
 */
export async function releasePendingServerActionClaim(
  client: PendingServerActionClient,
  args: {
    id: string;
    guildId: GuildId;
    actorDiscordId: UserDiscordId;
    claimToken: string;
  },
): Promise<boolean> {
  const result = await client.pendingServerAction.updateMany({
    where: {
      id: args.id,
      guildId: args.guildId,
      actorDiscordId: args.actorDiscordId,
      status: 'RUNNING',
      claimToken: args.claimToken,
    },
    data: { claimToken: null, claimedAt: null },
  });
  return result.count === 1;
}

export async function deleteExpiredPendingServerActions(
  client: PendingServerActionClient,
  now = new Date(),
): Promise<number> {
  const result = await client.pendingServerAction.deleteMany({
    where: {
      OR: [
        { status: 'PENDING', expiresAt: { lte: now } },
        { status: 'CONSUMED', consumedAt: { lt: new Date(now.getTime() - PENDING_SERVER_ACTION_TTL_MS) } },
        { status: 'RUNNING', createdAt: { lt: new Date(now.getTime() - PENDING_SERVER_ACTION_RECOVERY_RETENTION_MS) } },
      ],
    },
  });
  return result.count;
}
