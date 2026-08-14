/**
 * Privacy-sichere Nitrado-Outbox fuer Server-Banns.
 *
 * ADD braucht den echten Gameserver-Identifier. Er wird vor Persistenz mit
 * AES-256-GCM verschluesselt und nur bis zum Jobabschluss benoetigt.
 * REMOVE ueber eine lokale Ban-ID kann den Identifier spaeter aus der Remote-
 * Banlist per HMAC aufloesen. Fuer direkte Nitrado-Unbans ohne lokale Registry-
 * Zeile gibt es einen eigenen Identifier-Removal-Job; auch dort liegt der
 * Klartext nur verschluesselt in der kurzlebigen Job-Payload.
 */

import { encrypt } from '../../utils/security';

export type ServerBanJobOperation =
  | 'SERVER_BAN_ADD'
  | 'SERVER_BAN_REMOVE'
  | 'SERVER_BAN_REMOVE_IDENTIFIER';

export interface ServerBanJobPayload {
  banId: string;
  encryptedIdentifier?: string;
}

export interface ServerBanIdentifierRemovalPayload {
  identityHash: string;
  encryptedIdentifier: string;
}

export interface BanOutboxScope {
  guildId: string;
  nitradoConnId: string;
}

export interface BanOutboxClient {
  nitradoJob: {
    findMany: (args: unknown) => Promise<Array<{ payload: unknown }>>;
    create: (args: unknown) => Promise<unknown>;
  };
}

function asPayload(value: unknown): ServerBanJobPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.banId !== 'string' || !v.banId.trim()) return null;
  if (v.encryptedIdentifier !== undefined && typeof v.encryptedIdentifier !== 'string') return null;
  return {
    banId: v.banId,
    ...(typeof v.encryptedIdentifier === 'string' ? { encryptedIdentifier: v.encryptedIdentifier } : {}),
  };
}

function asIdentifierRemovalPayload(value: unknown): ServerBanIdentifierRemovalPayload | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.identityHash !== 'string' || !/^[0-9a-f]{64}$/i.test(v.identityHash)) return null;
  if (typeof v.encryptedIdentifier !== 'string' || !v.encryptedIdentifier.trim()) return null;
  return { identityHash: v.identityHash, encryptedIdentifier: v.encryptedIdentifier };
}

export function parseServerBanJobPayload(value: unknown): ServerBanJobPayload {
  const payload = asPayload(value);
  if (!payload) throw new Error('Ungueltige Server-Ban-Job-Payload');
  return payload;
}

export function parseServerBanIdentifierRemovalPayload(value: unknown): ServerBanIdentifierRemovalPayload {
  const payload = asIdentifierRemovalPayload(value);
  if (!payload) throw new Error('Ungueltige direkte Server-Unban-Payload');
  return payload;
}

async function activeJobPayloads(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  operation: ServerBanJobOperation,
): Promise<Array<{ payload: unknown }>> {
  return client.nitradoJob.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation,
      status: { in: ['PENDING', 'RUNNING'] },
    },
    select: { payload: true },
    take: 200,
  });
}

async function ensureBanIdJob(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  operation: 'SERVER_BAN_ADD' | 'SERVER_BAN_REMOVE',
  payload: ServerBanJobPayload,
): Promise<boolean> {
  const existing = await activeJobPayloads(client, scope, operation);
  if (existing.some(j => asPayload(j.payload)?.banId === payload.banId)) return false;

  await client.nitradoJob.create({
    data: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation,
      payload,
    },
  });
  return true;
}

/** Queued Remote-Ban; Klartext-Identifier wird nie unverschluesselt gespeichert. */
export async function enqueueServerBanAdd(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  banId: string,
  rawIdentifier: string,
  encryptionKey: string,
): Promise<boolean> {
  const identifier = rawIdentifier.trim();
  if (!identifier) throw new Error('Leerer Server-Ban-Identifier');
  return ensureBanIdJob(client, scope, 'SERVER_BAN_ADD', {
    banId,
    encryptedIdentifier: encrypt(identifier, encryptionKey),
  });
}

/** Queued Remote-Unban fuer eine vorhandene lokale Ban-Registry-Zeile. */
export async function enqueueServerBanRemove(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  banId: string,
): Promise<boolean> {
  return ensureBanIdJob(client, scope, 'SERVER_BAN_REMOVE', { banId });
}

/**
 * Direkter Nitrado-Unban per exaktem Identifier. Dieser Pfad funktioniert auch,
 * wenn der Bann extern/manuell angelegt wurde und lokal keine ServerBanEntry-
 * Zeile existiert.
 */
export async function enqueueServerBanIdentifierRemove(
  client: BanOutboxClient,
  scope: BanOutboxScope,
  identityHash: string,
  rawIdentifier: string,
  encryptionKey: string,
): Promise<boolean> {
  const identifier = rawIdentifier.trim();
  if (!identifier) throw new Error('Leerer Server-Unban-Identifier');
  if (!/^[0-9a-f]{64}$/i.test(identityHash)) throw new Error('Ungueltiger Server-Unban-IdentityHash');

  const existing = await activeJobPayloads(client, scope, 'SERVER_BAN_REMOVE_IDENTIFIER');
  if (existing.some(j => asIdentifierRemovalPayload(j.payload)?.identityHash === identityHash)) return false;

  await client.nitradoJob.create({
    data: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      operation: 'SERVER_BAN_REMOVE_IDENTIFIER',
      payload: {
        identityHash,
        encryptedIdentifier: encrypt(identifier, encryptionKey),
      },
    },
  });
  return true;
}
