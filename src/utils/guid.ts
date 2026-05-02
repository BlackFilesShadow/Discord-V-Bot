import { v4 as uuidv4, validate as uuidValidate } from 'uuid';
import crypto from 'crypto';

/**
 * Erzeugt eine kryptografisch sichere GUID (UUIDv4).
 * Sektion 1: Jeder Nutzer/Hersteller erhält eindeutige, kryptografisch sichere GUID.
 */
export function generateGuid(): string {
  return uuidv4();
}

/**
 * Validiert ob ein String eine gueltige UUIDv4 ist.
 */
export function isValidGuid(guid: string): boolean {
  return uuidValidate(guid);
}

/**
 * Validiert ein BattlEye-GUID (DayZ-Spieler-Identifier aus ADM-Logs).
 *
 * Echtes Format (PC):     32-stelliger lowercase-Hex (MD5 von 'BE' + Steam64).
 * Echtes Format (Console): URL-safe-base64 mit `=`-Padding,
 *   Beispiel `K_8HNTXPqt_fEXivA1ULIyMFAAfqxt4uiXBVG_C3_pU=` (44 Zeichen).
 * Wir sind bewusst etwas toleranter (8-64 alphanum + `_-`, optional `=`-Padding),
 * weil DayZ Console UND modded Server unterschiedliche Formate liefern. Wichtig
 * ist nur, dass eindeutig MUELL (Leer, 'Unknown', 'N/A', 'false', mit Whitespace,
 * mit Sonderzeichen) abgewiesen wird, damit GUID-strict-Auswertungen (Spec 13)
 * sauber bleiben.
 */
const RE_BATTLEYE_GUID = /^[A-Za-z0-9_-]{8,64}={0,2}$/;
const BATTLEYE_GUID_BLOCKLIST = new Set([
  'unknown', 'n/a', 'na', 'null', 'none', 'false', 'true', '0',
]);
export function isValidBattleyeGuid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const v = value.trim();
  if (v.length === 0) return false;
  if (BATTLEYE_GUID_BLOCKLIST.has(v.toLowerCase())) return false;
  return RE_BATTLEYE_GUID.test(v);
}

/**
 * Erzeugt eine kryptografisch sichere zufällige ID (hex).
 */
export function generateSecureId(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}
