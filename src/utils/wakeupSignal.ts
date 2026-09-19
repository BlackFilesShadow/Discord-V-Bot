/**
 * Minimaler In-Process-Pub/Sub fuer Fast-Path-Trigger zwischen Producer und
 * Poll-Worker. Ersetzt keinen bestehenden Intervall-Scheduler, sondern weckt
 * ihn zusaetzlich sofort auf; der Intervall bleibt als Fallback (Crash-
 * Recovery, verpasste Signale) unveraendert bestehen.
 *
 * Bewusst ohne Payload: jeder Listener fuehrt seinen eigenen, bereits
 * lockgesicherten Poll-Once-Durchlauf aus und liest den aktuellen DB-Zustand
 * selbst. Ein Fehler in einem Listener darf weder die restlichen Listener
 * noch den Producer stoeren.
 */
export interface WakeupSignal {
  subscribe(listener: () => void): () => void;
  fire(): void;
}

export function createWakeupSignal(): WakeupSignal {
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    fire() {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          // Listener kapseln eigene Fehlerbehandlung; ein einzelner defekter
          // Listener darf weder andere Listener noch den Producer stoppen.
        }
      }
    },
  };
}
