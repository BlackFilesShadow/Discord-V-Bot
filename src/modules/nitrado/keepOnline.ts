/**
 * Keep-Online-Statusmaschine (Phase 7, KEEP).
 *
 * Reine Entscheidungslogik: WANN ein gestoppter Server automatisch gestartet
 * werden soll. Zentrale Sicherheitsregel: ein `suspended` (gesperrter) Server
 * wird NIEMALS automatisch gestartet. Ist Keep-Online deaktiviert, wird nie
 * gestartet (sofortige Cancellation ergibt sich aus der naechsten Auswertung).
 * Der reale Nitrado-Start ist Sache des Aufrufers (capability-abhaengig, EXTERN).
 */

export type ServerRunState = 'started' | 'stopped' | 'suspended' | 'restarting' | 'unknown';
export type KeepOnlineAction = 'START' | 'NONE';

export function decideKeepOnlineAction(args: { enabled: boolean; state: ServerRunState }): KeepOnlineAction {
  if (!args.enabled) return 'NONE';
  // Nur einen sauber gestoppten Server starten — nie aus suspended/restarting/unknown.
  return args.state === 'stopped' ? 'START' : 'NONE';
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
