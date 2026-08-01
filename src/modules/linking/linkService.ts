/**
 * Link-Service (Phase 7) — code-first Verifikations-Flow.
 *
 * Ablauf: /link erzeugt eine PENDING-Bindung mit Challenge-Code (identityHash
 * noch leer). Der Nutzer tippt den Code im Spiel; die ADM-Erkennung ruft
 * `verifyByCode` mit der Spielidentitaet des Tippers auf. Erst dann wird
 * identityHash (HMAC) gesetzt und der Status VERIFIED. Der Klartext-GUID
 * verlaesst die Verify-Funktion nie (nur der Hash wird gespeichert).
 *
 * Idempotenz/Sicherheit: @@unique[guild,conn,identityHash] verhindert, dass zwei
 * Discord-Nutzer dieselbe Spielidentitaet verifizieren (P2002 -> IDENTITY_TAKEN).
 */

import { identityHash, newChallengeCode, isChallengeValid, CHALLENGE_TTL_MS } from './identity';

export interface LinkScope {
  guildId: string;
  nitradoConnId: string;
}

export interface GameIdentityRow {
  userDiscordId: string;
  identityHash: string | null;
  status: 'PENDING' | 'VERIFIED' | 'UNLINKED';
  challengeCode: string | null;
  challengeExpiresAt: Date | null;
}

export interface LinkClient {
  gameIdentityLink: {
    findFirst: (args: unknown) => Promise<GameIdentityRow | null>;
    upsert: (args: { where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }) => Promise<unknown>;
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => Promise<{ count: number }>;
  };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

export interface ResolveClient {
  gameIdentityLink: {
    findFirst: (args: unknown) => Promise<{ userDiscordId: string } | null>;
  };
}

/** Loest eine Spiel-Identitaet (Klartext-gameId) zum verifizierten Discord-User
 *  auf — ueber den HMAC-Hash, ohne den Klartext zu speichern. Nur VERIFIED. */
export async function resolveVerifiedUser(
  client: ResolveClient,
  scope: LinkScope,
  gameId: string,
  secret: string,
): Promise<string | null> {
  const hash = identityHash(gameId, secret);
  const link = await client.gameIdentityLink.findFirst({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, identityHash: hash, status: 'VERIFIED' },
  });
  return link?.userDiscordId ?? null;
}

/** Erstellt/erneuert eine PENDING-Bindung mit frischem Challenge-Code. */
export async function createLinkChallenge(
  client: LinkClient,
  scope: LinkScope,
  userDiscordId: string,
  now: Date = new Date(),
): Promise<{ code: string; expiresAt: Date }> {
  const code = newChallengeCode();
  const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
  await client.gameIdentityLink.upsert({
    where: { guildId_nitradoConnId_userDiscordId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, userDiscordId } },
    create: {
      guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, userDiscordId,
      identityHash: null, status: 'PENDING', challengeCode: code, challengeExpiresAt: expiresAt,
    },
    // Re-Link: Identitaet zuruecksetzen, neuer Code.
    update: { identityHash: null, status: 'PENDING', challengeCode: code, challengeExpiresAt: expiresAt, verifiedAt: null },
  });
  return { code, expiresAt };
}

export type VerifyResult =
  | { verified: true; userDiscordId: string }
  | { verified: false; reason: 'NO_CHALLENGE' | 'INVALID_OR_EXPIRED' | 'IDENTITY_TAKEN' };

/** Verifiziert einen im Spiel getippten Code fuer die Identitaet `gameId`. */
export async function verifyByCode(
  client: LinkClient,
  scope: LinkScope,
  code: string,
  gameId: string,
  secret: string,
  now: Date = new Date(),
): Promise<VerifyResult> {
  const link = await client.gameIdentityLink.findFirst({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, challengeCode: code.trim().toUpperCase(), status: 'PENDING' },
  });
  if (!link) return { verified: false, reason: 'NO_CHALLENGE' };
  if (!isChallengeValid(link, code, now)) return { verified: false, reason: 'INVALID_OR_EXPIRED' };

  const hash = identityHash(gameId, secret);
  try {
    const r = await client.gameIdentityLink.updateMany({
      where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, userDiscordId: link.userDiscordId, status: 'PENDING' },
      data: { identityHash: hash, status: 'VERIFIED', verifiedAt: now, challengeCode: null, challengeExpiresAt: null },
    });
    if (r.count !== 1) return { verified: false, reason: 'INVALID_OR_EXPIRED' };
    return { verified: true, userDiscordId: link.userDiscordId };
  } catch (e) {
    if (isUniqueViolation(e)) return { verified: false, reason: 'IDENTITY_TAKEN' }; // Identitaet bereits verifiziert
    throw e;
  }
}

/** Soft-Unlink: Historie bleibt, Status UNLINKED. Gibt true zurueck, wenn eine
 *  aktive (PENDING/VERIFIED) Bindung entfernt wurde. */
export async function unlinkUser(
  client: LinkClient,
  scope: LinkScope,
  userDiscordId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const r = await client.gameIdentityLink.updateMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, userDiscordId, status: { in: ['PENDING', 'VERIFIED'] } },
    data: { status: 'UNLINKED', unlinkedAt: now, challengeCode: null, challengeExpiresAt: null },
  });
  return r.count > 0;
}

/** Admin: direkte Verifikation ohne Challenge. */
export async function forceLink(
  client: LinkClient,
  scope: LinkScope,
  userDiscordId: string,
  gameId: string,
  secret: string,
  now: Date = new Date(),
): Promise<{ ok: true } | { ok: false; reason: 'IDENTITY_TAKEN' }> {
  const hash = identityHash(gameId, secret);
  try {
    await client.gameIdentityLink.upsert({
      where: { guildId_nitradoConnId_userDiscordId: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, userDiscordId } },
      create: {
        guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, userDiscordId,
        identityHash: hash, status: 'VERIFIED', verifiedAt: now,
      },
      update: { identityHash: hash, status: 'VERIFIED', verifiedAt: now, challengeCode: null, challengeExpiresAt: null, unlinkedAt: null },
    });
    return { ok: true };
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, reason: 'IDENTITY_TAKEN' };
    throw e;
  }
}
