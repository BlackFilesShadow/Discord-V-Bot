import { createWakeupSignal } from '../../utils/wakeupSignal';

/**
 * Feuert, sobald die Ban-Outbox tatsaechlich einen neuen NitradoJob angelegt
 * hat (nach Commit). Der Job-Worker nutzt das, um seinen ohnehin vorhandenen,
 * lockgesicherten Poll-Durchlauf sofort statt erst beim naechsten
 * 10s-Intervall anzustossen. Traegt absichtlich keinen Job-Kontext: der
 * Worker liest Claim/Lease/Payload weiterhin ausschliesslich aus der DB.
 */
export const nitradoJobEnqueued = createWakeupSignal();
