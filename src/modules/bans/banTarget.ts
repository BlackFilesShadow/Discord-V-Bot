/**
 * Sichere Zielaufloesung fuer Server-Banns.
 *
 * Server-Banns duerfen direkt ueber einen exakten Gameserver-Identifier
 * adressiert werden. Eine Discord-/Bot-Verknuepfung ist dafuer nicht erforderlich.
 * Persistiert wird weiterhin nur der HMAC-Hash des Identifiers; Klartext bleibt
 * auf Command-/Worker-Laufzeit beschraenkt.
 *
 * Die VERIFIED-Link-Aufloesung bleibt fuer bestehende Call-Sites erhalten, ist
 * aber keine Vorbedingung mehr fuer /server-ban oder /server-unban.
 */

import { timingSafeEqual } from 'crypto';
import { identityHash } from '../linking/identity';

export interface BanTargetScope {
  guildId: string;
  nitradoConnId: string;
}

export interface BanTargetClient {
  gameIdentityLink: {
    findFirst: (args: unknown) => Promise<{ identityHash: string | null } | null>;
  };
}

/** HMAC eines exakten Gameserver-Identifiers; Klartext wird nicht persistiert. */
export function hashBanIdentifier(rawIdentifier: string, secret: string): string {
  return identityHash(rawIdentifier.trim(), secret);
}

/**
 * Liefert den HMAC-Hash eines VERIFIED Links im exakten Guild+Slot-Scope.
 * PENDING/UNLINKED/fehlende Links ergeben null.
 */
export async function resolveVerifiedBanIdentityHash(
  client: BanTargetClient,
  scope: BanTargetScope,
  userDiscordId: string,
): Promise<string | null> {
  const row = await client.gameIdentityLink.findFirst({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      userDiscordId,
      status: 'VERIFIED',
      identityHash: { not: null },
    },
    select: { identityHash: true },
  });

  return row?.identityHash ?? null;
}

/**
 * Prueft einen nur zur Laufzeit vorhandenen Gameserver-Identifier gegen einen
 * gespeicherten HMAC. Timing-safe, damit keine Hash-Information ueber
 * Vergleichszeiten abgeleitet werden kann.
 */
export function matchesBanIdentifier(
  rawIdentifier: string,
  expectedIdentityHash: string,
  secret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedIdentityHash)) return false;
  const actual = Buffer.from(hashBanIdentifier(rawIdentifier, secret), 'hex');
  const expected = Buffer.from(expectedIdentityHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
