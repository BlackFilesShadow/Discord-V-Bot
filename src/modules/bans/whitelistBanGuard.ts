/**
 * Gemeinsame Ban-Grenze fuer jeden Whitelist-Write.
 *
 * Der Lookup wird immer mit der HMAC des konkreten Gameserver-Identifiers und
 * dem exakten Guild-/Nitrado-Scope ausgefuehrt. Ein Ban auf einem anderen Slot
 * oder in einer anderen Guild blockiert daher niemals diese Whitelist-Aktion.
 */
import { config } from '../../config';
import { candidateBanIdentifierHashes } from './banTarget';
import { isBanned, type BanClient, type BanScope } from './banRegistry';

export const ACTIVE_BAN_WHITELIST_WARNING =
  '⚠️ Dein angegebener Username wurde auf diesem Gameserver gebannt. Die Whitelist-Freigabe wurde nicht durchgeführt.';

export async function isWhitelistBlockedByActiveServerBan(
  client: BanClient,
  scope: BanScope,
  gameId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const normalizedGameId = gameId.trim();
  if (!normalizedGameId) return false;

  // Prueft sowohl die aktuelle case-normalisierte als auch die Legacy-Exakt-
  // Hash-Form (siehe banTarget.candidateBanIdentifierHashes), damit ein Bann
  // unabhaengig von Gross-/Kleinschreibung des Whitelist-Antrags erkannt wird.
  for (const hash of candidateBanIdentifierHashes(normalizedGameId, config.security.encryptionKey)) {
    if (await isBanned(client, scope, hash, now)) return true;
  }
  return false;
}
