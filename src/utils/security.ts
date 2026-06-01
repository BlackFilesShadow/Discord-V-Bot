import crypto from 'crypto';
import speakeasy from 'speakeasy';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256 -> 32-Byte-Schluessel (64 Hex-Zeichen)
const IV_BYTES = 12; // GCM-Standard-IV (96 Bit). IV wird pro Ciphertext gespeichert,
//                      daher sind aeltere 16-Byte-IV-Blobs weiterhin entschluesselbar.
const AUTH_TAG_BYTES = 16;

/**
 * Verschlüsselung/Entschlüsselung für Token und sensible Daten.
 * Sektion 12: Refresh-Token verschlüsselt, nur Server-seitig.
 */

/** Validiert und liest den Hex-Schluessel; wirft kontrolliert bei falscher Laenge. */
function loadKey(encryptionKey: string): Buffer {
  if (typeof encryptionKey !== 'string' || !/^[0-9a-fA-F]+$/.test(encryptionKey)) {
    throw new Error('Ungueltiger Encryption-Key (kein Hex).');
  }
  const key = Buffer.from(encryptionKey, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(`Encryption-Key muss ${KEY_BYTES} Bytes (${KEY_BYTES * 2} Hex-Zeichen) sein.`);
  }
  return key;
}

/**
 * Verschlüsselt einen String mit AES-256-GCM.
 */
export function encrypt(text: string, encryptionKey: string): string {
  const key = loadKey(encryptionKey);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Entschlüsselt einen mit encrypt() verschlüsselten String.
 * Validiert Format und Bestandteile, bevor die Krypto-Engine aufgerufen wird,
 * damit kein roher TypeError mit internen Details nach aussen dringt.
 */
export function decrypt(encryptedText: string, encryptionKey: string): string {
  const key = loadKey(encryptionKey);
  if (typeof encryptedText !== 'string') {
    throw new Error('Ungueltiger Ciphertext.');
  }
  const parts = encryptedText.split(':');
  if (parts.length !== 3 || !parts.every((p) => /^[0-9a-fA-F]*$/.test(p) && p.length > 0)) {
    throw new Error('Ungueltiges Ciphertext-Format.');
  }
  const [ivHex, authTagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  if (authTag.length !== AUTH_TAG_BYTES || iv.length < 12 || iv.length > 16) {
    throw new Error('Ungueltige IV-/AuthTag-Laenge.');
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * SHA-256 Hash berechnen (für Datei-Integrität).
 * Sektion 2: Integritätsprüfung (Hash).
 */
export function sha256Hash(data: Buffer | string): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * 2FA TOTP Setup (Sektion 12: 2FA verpflichtend für Developer/Admins).
 */
export function generate2FASecret(userLabel: string, issuer: string): {
  secret: string;
  otpAuthUrl: string;
  base32: string;
} {
  const secret = speakeasy.generateSecret({
    name: `${issuer}:${userLabel}`,
    issuer: issuer,
    length: 32,
  });

  return {
    secret: secret.ascii || '',
    otpAuthUrl: secret.otpauth_url || '',
    base32: secret.base32 || '',
  };
}

/**
 * 2FA TOTP Code verifizieren.
 */
export function verify2FAToken(secret: string, token: string): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: 'base32',
    token,
    window: 1, // 1 Zeitfenster Toleranz
  });
}

/**
 * Generiert Backup-Codes für 2FA.
 * 8 Zufallsbytes pro Code (64 Bit Entropie) als Uppercase-Hex.
 */
export function generateBackupCodes(count: number = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    codes.push(crypto.randomBytes(8).toString('hex').toUpperCase());
  }
  return codes;
}

/**
 * CSRF-Token generieren (State-Parameter für OAuth2).
 * Sektion 12: State-Parameter für CSRF-Schutz.
 */
export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Nonce generieren (Replay-Schutz).
 * Sektion 12: Nonce für Replay-Schutz.
 */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * PKCE Code Verifier und Challenge generieren.
 * Sektion 12: PKCE für Public Clients.
 */
export function generatePKCE(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');

  return { codeVerifier, codeChallenge };
}
