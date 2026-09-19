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

/**
 * HMAC eines exakten Gameserver-Identifiers; Klartext wird nicht persistiert.
 * Normalisiert auf Kleinschreibung: Nitrado/DayZ behandeln Whitelist- und
 * Bannlisten-Identitaeten durchgaengig case-insensitiv (siehe nitradoClient.ts
 * addToWhitelist/addToBanlist sowie die case-insensitive WhitelistEntry-Updates
 * in serverBan.ts), daher muss derselbe Identifier unabhaengig von Gross-/
 * Kleinschreibung immer denselben Hash ergeben.
 */
export function hashBanIdentifier(rawIdentifier: string, secret: string): string {
  return identityHash(rawIdentifier.trim().toLowerCase(), secret);
}

/**
 * Alle Hash-Varianten, unter denen derselbe Identifier gespeichert sein kann:
 * die aktuelle, case-normalisierte Form (canonical) sowie — fuer Eintraege aus
 * der Zeit vor dieser Normalisierung — die exakte Original-Schreibweise
 * (legacy). Der Hash ist bewusst nicht umkehrbar, ein Klartext-Backfill auf
 * die neue Form ist daher nicht moeglich; ohne diesen Fallback wuerden vor dem
 * Fix gespeicherte Banns/Links bei erneuter Pruefung unverifizierbar.
 */
export function candidateBanIdentifierHashes(rawIdentifier: string, secret: string): string[] {
  const trimmed = rawIdentifier.trim();
  const canonical = identityHash(trimmed.toLowerCase(), secret);
  const legacyExact = identityHash(trimmed, secret);
  return canonical === legacyExact ? [canonical] : [canonical, legacyExact];
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
 * gespeicherten HMAC. Prueft sowohl die aktuelle case-normalisierte Form als
 * auch die Legacy-Exaktschreibweise (siehe candidateBanIdentifierHashes), damit
 * ein vor der Normalisierung gespeicherter Bann durch exakte Neueingabe weiter
 * verifizierbar bleibt. Timing-safe, damit keine Hash-Information ueber
 * Vergleichszeiten abgeleitet werden kann.
 */
export function matchesBanIdentifier(
  rawIdentifier: string,
  expectedIdentityHash: string,
  secret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedIdentityHash)) return false;
  const expected = Buffer.from(expectedIdentityHash, 'hex');
  return candidateBanIdentifierHashes(rawIdentifier, secret).some(candidate => {
    const actual = Buffer.from(candidate, 'hex');
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}
