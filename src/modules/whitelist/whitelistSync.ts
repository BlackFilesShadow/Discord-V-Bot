/**
 * Whitelist-V2 Diff (Phase 7, WL-V2). Reine Abgleichslogik zwischen der lokalen
 * Whitelist und der am Gameserver vorhandenen (remote) Liste. Namen sind
 * case-insensitiv (Nitrado verwaltet die Whitelist per Name).
 *
 * Der eigentliche 5-Minuten-Sync inkl. voller Pagination gegen die Nitrado-API
 * ist Sache des Aufrufers (EXTERN) — diese Funktion trifft nur die Entscheidung.
 */

export interface WhitelistDiff {
  toAdd: string[];    // lokal vorhanden, remote fehlt -> am Server hinzufuegen
  toRemove: string[]; // remote vorhanden, lokal nicht (mehr) -> am Server entfernen
  synced: string[];   // beidseitig vorhanden
}

function norm(name: string): string {
  return name.trim().toLowerCase();
}

export function diffWhitelist(localNames: string[], remoteNames: string[]): WhitelistDiff {
  const localMap = new Map<string, string>(); // norm -> original
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
