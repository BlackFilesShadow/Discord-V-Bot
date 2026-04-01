import argon2 from 'argon2';
import crypto from 'crypto';

/**
 * Einmal-Passwort-Generierung (Sektion 1):
 * - Hochkomplex, zeitlich limitiert, nur für GUID gültig
 * - Passwort sofort ungültig nach Nutzung
 */

/**
 * Erzeugt ein hochkomplexes Einmal-Passwort.
 * Mindestens 32 Zeichen: Groß-/Kleinbuchstaben, Zahlen, Sonderzeichen.
 */
export function generateOneTimePassword(length: number = 48): string {
  const upper = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower = 'abcdefghijklmnopqrstuvwxyz';
  const digits = '0123456789';
  const special = '!@#$%^&*()-_=+[]{}|;:,.<>?';
  const all = upper + lower + digits + special;

  // Sicherstellen, dass mindestens ein Zeichen jeder Kategorie enthalten
  const password: string[] = [];
  password.push(upper[crypto.randomInt(upper.length)]);
  password.push(lower[crypto.randomInt(lower.length)]);
  password.push(digits[crypto.randomInt(digits.length)]);
  password.push(special[crypto.randomInt(special.length)]);

  for (let i = password.length; i < length; i++) {
    password.push(all[crypto.randomInt(all.length)]);
  }

  // Fisher-Yates Shuffle mit kryptografisch sicherem Random
  for (let i = password.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [password[i], password[j]] = [password[j], password[i]];
  }

  return password.join('');
}

/**
 * Hasht ein Passwort mit Argon2id (empfohlen über bcrypt).
 * Sektion 5: Sichere Passwort-Verwaltung (Argon2).
 */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536, // 64 MB
    timeCost: 3,
    parallelism: 4,
  });
}

/**
 * Verifiziert ein Passwort gegen einen Argon2-Hash.
 */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}

/**
 * Generiert einen sicheren Token (z.B. für Session, API-Key).
 */
export function generateSecureToken(bytes: number = 64): string {
  return crypto.randomBytes(bytes).toString('base64url');
}
