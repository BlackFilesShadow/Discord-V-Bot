/**
 * Sichere Zielauflösung für Server-Banns.
 *
 * Ein Ban-Command adressiert einen Discord-Nutzer. Gebannt wird intern jedoch
 * ausschließlich dessen bereits VERIFIED GameIdentityLink-HMAC. Rohe Game-IDs
 * werden hier weder dauerhaft gespeichert noch geloggt.
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
 * Prüft einen nur zur Laufzeit vorhandenen Gameserver-Identifier gegen den
 * bereits gespeicherten HMAC. Der Klartext wird nicht persistiert.
 *
 * Timing-safe Vergleich verhindert, dass ein Angreifer aus Vergleichszeiten
 * schrittweise Informationen über den erwarteten HMAC ableiten kann.
 */
export function matchesBanIdentifier(
  rawIdentifier: string,
  expectedIdentityHash: string,
  secret: string,
): boolean {
  if (!/^[0-9a-f]{64}$/i.test(expectedIdentityHash)) return false;
  const actual = Buffer.from(identityHash(rawIdentifier, secret), 'hex');
  const expected = Buffer.from(expectedIdentityHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
