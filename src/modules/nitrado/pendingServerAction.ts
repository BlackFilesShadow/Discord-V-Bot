import { randomUUID } from 'node:crypto';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';

/** Phase 4 / SCOPE-003: Pending-Actions leben hoechstens fuenf Minuten. */
export const PENDING_SERVER_ACTION_TTL_MS = 5 * 60 * 1000;

export type PendingServerActionStatus = 'PENDING' | 'CONSUMED';

export interface PendingServerActionRow {
  id: string;
  guildId: string;
  nitradoConnId: string;
  actorDiscordId: string;
  actionType: string;
  payload: unknown;
  status: PendingServerActionStatus;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

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
      // SCOPE-003: Die Action-ID ist kryptografisch zufaellig und wird bewusst
      // im Service erzeugt (nicht nur ueber einen ORM-Default), damit auch
      // alternative/injizierte Persistenzadapter dieselbe Sicherheitsregel haben.
      id: randomUUID(),
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      actorDiscordId: args.actorDiscordId,
      actionType,
      payload,
      status: 'PENDING',
      expiresAt: new Date(now.getTime() + ttlMs),
    },
  });
}

/**
 * Atomarer One-Shot-Claim. Genau ein konkurrierender Consumer darf PENDING ->
 * CONSUMED setzen; alle weiteren sehen null. Der Payload wird erst nach einem
 * erfolgreichen Claim zurueckgegeben.
 */
export async function consumePendingServerAction(
  client: PendingServerActionClient,
  args: {
    id: string;
    guildId: GuildId;
    actorDiscordId: UserDiscordId;
    nitradoConnId?: NitradoConnId;
    now?: Date;
  },
): Promise<PendingServerActionRow | null> {
  const now = args.now ?? new Date();
  const where: Record<string, unknown> = {
    id: args.id,
    guildId: args.guildId,
    actorDiscordId: args.actorDiscordId,
    status: 'PENDING',
    expiresAt: { gt: now },
  };
  if (args.nitradoConnId) where.nitradoConnId = args.nitradoConnId;

  const claimed = await client.pendingServerAction.updateMany({
    where,
    data: { status: 'CONSUMED', consumedAt: now },
  });
  if (claimed.count !== 1) return null;

  return client.pendingServerAction.findFirst({
    where: {
      id: args.id,
      guildId: args.guildId,
      actorDiscordId: args.actorDiscordId,
      status: 'CONSUMED',
      consumedAt: now,
    },
  });
}

export async function deleteExpiredPendingServerActions(
  client: PendingServerActionClient,
  now = new Date(),
): Promise<number> {
  const result = await client.pendingServerAction.deleteMany({
    where: {
      OR: [
        { expiresAt: { lte: now } },
        { status: 'CONSUMED', consumedAt: { lt: new Date(now.getTime() - PENDING_SERVER_ACTION_TTL_MS) } },
      ],
    },
  });
  return result.count;
}
