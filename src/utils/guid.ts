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
 * Validiert ob ein String eine gültige UUIDv4 ist.
 */
export function isValidGuid(guid: string): boolean {
  return uuidValidate(guid);
}

/**
 * Erzeugt eine kryptografisch sichere zufällige ID (hex).
 */
export function generateSecureId(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}
