/**
 * Whitelist-V2 Diff (Phase 7, WL-V2). Reine Abgleichslogik zwischen der lokalen
 * Whitelist und der am Gameserver vorhandenen Liste. Namen sind case-insensitiv.
 *
 * Der produktive 5-Minuten-Abgleich ist inzwischen in `whitelistSyncCron.ts`
 * verdrahtet. Er liest das vollstaendige DayZ-`general.whitelist`-Setting ueber
 * `NitradoClient.getWhitelist()` und legt notwendige Aenderungen ausschliesslich
 * als NitradoJob-Outbox-Jobs an. Diese Datei bleibt bewusst I/O-freie, testbare
 * Entscheidungslogik.
 */

export interface WhitelistDiff {
  toAdd: string[];
  toRemove: string[];
  synced: string[];
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

export function diffWhitelist(localNames: string[], remoteNames: string[]): WhitelistDiff {
  const localMap = new Map<string, string>();
  for (const n of localNames) { const k = norm(n); if (k) localMap.set(k, n); }
  const remoteSet = new Set(remoteNames.map(norm).filter(Boolean));

  const toAdd: string[] = [];
  const synced: string[] = [];
  for (const [k, original] of localMap) {
    if (remoteSet.has(k)) synced.push(original);
    else toAdd.push(original);
  }

  const toRemove: string[] = [];
  for (const r of remoteNames) {
    const k = norm(r);
    if (k && !localMap.has(k)) toRemove.push(r);
  }

  return { toAdd, toRemove, synced };
}

export type WhitelistSyncStateV2 = 'LOCAL_ONLY' | 'SYNCED' | 'PENDING_REMOVE';

/** Neuer Sync-Status eines lokalen Eintrags nach dem Abgleich. */
export function resolveEntryState(existsRemote: boolean): WhitelistSyncStateV2 {
  return existsRemote ? 'SYNCED' : 'LOCAL_ONLY';
}
