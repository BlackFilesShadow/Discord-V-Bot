import { createWakeupSignal } from '../../utils/wakeupSignal';

/**
 * Feuert, sobald runtime.ts ein neues RadarZoneEvent persistiert hat. Der
 * Auto-Ban-Worker nutzt das, um seinen ohnehin vorhandenen, lockgesicherten
 * Poll-Durchlauf sofort statt erst beim naechsten 15s-Intervall anzustossen.
 * Traegt absichtlich keinen Zonen-/Event-Kontext: jeder Listener validiert
 * ausschliesslich gegen den aktuellen DB-Zustand.
 */
export const radarZoneEventCreated = createWakeupSignal();
