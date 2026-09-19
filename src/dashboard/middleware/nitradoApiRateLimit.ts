/**
 * Nitrado-API-Rate-Limit (Dashboard).
 *
 * Der globale Dashboard-`apiLimiter` (server.ts) ueberspringt JEDE eingeloggte
 * Session vollstaendig (`skip: Boolean(session.userId)`). Die Nitrado-Slot-
 * Routen loesen aber echte Calls gegen die Nitrado-API aus (Token-Validierung,
 * `listServices`) und teilen sich dabei einen PROZESSWEITEN Circuit-Breaker
 * ueber ALLE Guilds hinweg (siehe `modules/nitrado/circuitBreaker.ts`, nur
 * je ein READ- und ein WRITE-Breaker, bewusst nicht pro Connection).
 *
 * Ohne eigenes Limit kann ein einzelner eingeloggter Nutzer mit
 * `dashboard.access` (z. B. durch wiederholte Tokenpruefungen, die bei
 * Nitrado in 429/5xx laufen) den READ- oder WRITE-Breaker fuer ALLE Guilds
 * gleichzeitig oeffnen ("Noisy Neighbor"-DoS), und `POST /nitrado` fungiert
 * ausserdem als offenes Orakel zum Testen beliebiger Nitrado-Tokens gegen die
 * echte API.
 *
 * Dieses Limit gilt zusaetzlich zum globalen `apiLimiter`, wird NICHT fuer
 * eingeloggte Sessions uebersprungen und ist pro Nutzer (fallback: IP)
 * gekeyt -- bewusst nicht pro Guild, damit auch ein Nutzer mit Zugriff auf
 * mehrere Guilds den geteilten Breaker nicht durch Verteilen der Calls auf
 * mehrere Guilds umgehen kann.
 */
import rateLimit from 'express-rate-limit';

export const nitradoApiRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.auth?.userId ?? req.ip ?? 'unknown',
  message: {
    error: 'Zu viele Nitrado-API-Anfragen. Bitte kurz warten, bevor du es erneut versuchst.',
    code: 'NITRADO_API_RATE_LIMITED',
  },
});
