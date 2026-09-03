/**
 * Gemeinsame Ban-Grenze fuer jeden Whitelist-Write.
 *
 * Der Lookup wird immer mit der HMAC des konkreten Gameserver-Identifiers und
 * dem exakten Guild-/Nitrado-Scope ausgefuehrt. Ein Ban auf einem anderen Slot
 * oder in einer anderen Guild blockiert daher niemals diese Whitelist-Aktion.
 */
import { config } from '../../config';
import { hashBanIdentifier } from './banTarget';
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

  return isBanned(
    client,
    scope,
    hashBanIdentifier(normalizedGameId, config.security.encryptionKey),
    now,
  );
}
