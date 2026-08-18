import prisma from '../../database/prisma';

export type WhitelistJobOperation = 'WHITELIST_ADD' | 'WHITELIST_REMOVE';
export type WhitelistDesiredState = 'PRESENT' | 'PENDING_REMOVE' | 'UNTRACKED';

export interface WhitelistIntentDecision {
  execute: boolean;
  desiredState: WhitelistDesiredState;
  reason: 'CURRENT_INTENT' | 'SUPERSEDED_BY_REMOVE' | 'SUPERSEDED_BY_PRESENT';
}

function norm(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

/**
 * Liest unmittelbar vor einem Remote-Whitelist-Write die aktuelle lokale
 * Source-of-Truth fuer exakt Guild + Gameserver + Spielernamen.
 *
 * Mehrere case-variierte Legacy-Zeilen werden konservativ zusammengefuehrt:
 * sobald irgendeine passende Zeile aktiv ist, gilt PRESENT. Nur wenn keine
 * aktive Zeile existiert, aber mindestens eine PENDING_REMOVE-Zeile, gilt der
 * Entfernen-Wunsch. Ohne lokale Zeile bleibt REMOVE fuer remote-only Eintraege
 * erlaubt, waehrend ein alter ADD als superseded gilt.
 */
export async function readWhitelistDesiredState(
  guildId: string,
  nitradoConnId: string,
  rawGameId: string,
): Promise<WhitelistDesiredState> {
  const gameId = rawGameId.trim();
  if (!gameId) throw new Error('Whitelist-Intent: leerer Gameserver-Identifier.');
  const target = norm(gameId);

  const rows = await prisma.whitelistEntry.findMany({
    where: { guildId, nitradoConnId },
    select: { gameId: true, syncState: true },
  });
  const matching = rows.filter(row => norm(row.gameId) === target);

  if (matching.some(row => row.syncState !== 'PENDING_REMOVE')) return 'PRESENT';
  if (matching.some(row => row.syncState === 'PENDING_REMOVE')) return 'PENDING_REMOVE';
  return 'UNTRACKED';
}

/**
 * Entscheidet die Remote-Ausfuehrung ausschliesslich nach dem AKTUELLEN lokalen
 * Sollzustand, nicht nach Job-Alter oder Retry-Reihenfolge.
 *
 * ADD:
 *   PRESENT        -> ausfuehren
 *   PENDING_REMOVE -> stale/superseded, no-op DONE
 *   UNTRACKED      -> stale/superseded, no-op DONE
 *
 * REMOVE:
 *   PRESENT        -> stale/superseded, no-op DONE
 *   PENDING_REMOVE -> ausfuehren
 *   UNTRACKED      -> ausfuehren (bewusst: remote-only Remove bleibt moeglich)
 */
export async function decideWhitelistRemoteIntent(
  operation: WhitelistJobOperation,
  guildId: string,
  nitradoConnId: string,
  gameId: string,
): Promise<WhitelistIntentDecision> {
  const desiredState = await readWhitelistDesiredState(guildId, nitradoConnId, gameId);

  if (operation === 'WHITELIST_ADD') {
    return desiredState === 'PRESENT'
      ? { execute: true, desiredState, reason: 'CURRENT_INTENT' }
      : { execute: false, desiredState, reason: 'SUPERSEDED_BY_REMOVE' };
  }

  return desiredState === 'PRESENT'
    ? { execute: false, desiredState, reason: 'SUPERSEDED_BY_PRESENT' }
    : { execute: true, desiredState, reason: 'CURRENT_INTENT' };
}
