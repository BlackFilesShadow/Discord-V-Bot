/**
 * Keep-Online-Statusmaschine (Phase 7, KEEP).
 *
 * Reine Entscheidungslogik: WANN ein gestoppter oder tatsaechlich offline
 * befindlicher Server automatisch gestartet werden soll. Zentrale
 * Sicherheitsregel: ein `suspended` (gesperrter) Server wird NIEMALS
 * automatisch gestartet. Ist Keep-Online deaktiviert, wird nie gestartet.
 *
 * Die reale Ausfuehrung ist inzwischen produktiv verdrahtet:
 * `permaOnlyCron` enqueued deduplizierte `RESTART_IF_DOWN`-Jobs und der
 * `jobWorker` prueft Remote-Status + keepOnlineEnabled unmittelbar vor
 * `NitradoClient.start()`. Diese Datei bleibt bewusst die testbare, reine
 * Entscheidungsfunktion und ist nicht selbst fuer HTTP-I/O verantwortlich.
 */

export type ServerRunState = 'started' | 'stopped' | 'offline' | 'suspended' | 'restarting' | 'unknown';
export type KeepOnlineAction = 'START' | 'NONE';

export function decideKeepOnlineAction(args: { enabled: boolean; state: ServerRunState }): KeepOnlineAction {
  if (!args.enabled) return 'NONE';
  return args.state === 'stopped' || args.state === 'offline' ? 'START' : 'NONE';
}

export interface KeepOnlineSlot {
  nitradoConnId: string;
  enabled: boolean;
  state: ServerRunState;
}

/** Reconciliation: liefert die Slots, die gestartet werden muessen. */
export function reconcileKeepOnline(slots: KeepOnlineSlot[]): string[] {
  return slots
    .filter(s => decideKeepOnlineAction({ enabled: s.enabled, state: s.state }) === 'START')
    .map(s => s.nitradoConnId);
}
