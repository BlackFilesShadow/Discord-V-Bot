import {
  encrypt,
  decrypt,
  sha256Hash,
  generate2FASecret,
  verify2FAToken,
  generateBackupCodes,
  generateCsrfToken,
  generateNonce,
  generatePKCE,
} from '../../src/utils/security';
import crypto from 'crypto';

// Erzeuge einen gültigen 256-Bit-Schlüssel für Tests
const TEST_KEY = crypto.randomBytes(32).toString('hex');

describe('Security Utility (Sektion 4, 5, 12)', () => {
  describe('encrypt / decrypt (AES-256-GCM)', () => {
    it('sollte einen Text korrekt verschlüsseln und entschlüsseln', () => {
      const plaintext = 'Geheimer Token 123!';
      const encrypted = encrypt(plaintext, TEST_KEY);
      const decrypted = decrypt(encrypted, TEST_KEY);
      expect(decrypted).toBe(plaintext);
    });

    it('sollte unterschiedliche Ciphertexte für gleichen Plaintext erzeugen (Random IV)', () => {
      const plaintext = 'Test';
      const enc1 = encrypt(plaintext, TEST_KEY);
      const enc2 = encrypt(plaintext, TEST_KEY);
      expect(enc1).not.toBe(enc2);
    });

    it('sollte bei falschem Key fehlschlagen', () => {
      const encrypted = encrypt('test', TEST_KEY);
      const wrongKey = crypto.randomBytes(32).toString('hex');
      expect(() => decrypt(encrypted, wrongKey)).toThrow();
    });

    it('sollte das Format iv:authTag:ciphertext haben', () => {
      const encrypted = encrypt('test', TEST_KEY);
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatch(/^[0-9a-f]{32}$/); // 16 bytes IV
      expect(parts[1]).toMatch(/^[0-9a-f]{32}$/); // 16 bytes auth tag
    });

    it('sollte bei manipuliertem Ciphertext fehlschlagen (Authentizität)', () => {
      const encrypted = encrypt('test', TEST_KEY);
      const parts = encrypted.split(':');
      // Manipuliere den Ciphertext
      const tampered = parts[0] + ':' + parts[1] + ':' + 'ff'.repeat(parts[2].length / 2);
      expect(() => decrypt(tampered, TEST_KEY)).toThrow();
    });
  });

  describe('sha256Hash', () => {
    it('sollte einen korrekten SHA-256-Hash berechnen', () => {
      const hash = sha256Hash('hello');
      expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('sollte Buffer akzeptieren', () => {
      const hash = sha256Hash(Buffer.from('hello'));
      expect(hash).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    });

    it('sollte deterministisch sein', () => {
      expect(sha256Hash('test')).toBe(sha256Hash('test'));
    });
  });

  describe('2FA TOTP (Sektion 12)', () => {
    it('sollte ein Secret mit OTP-Auth-URL erzeugen', () => {
      const result = generate2FASecret('testuser', 'Discord-V-Bot');
      expect(result.secret).toBeTruthy();
      expect(result.base32).toBeTruthy();
      expect(result.otpAuthUrl).toContain('otpauth://totp/');
      expect(result.otpAuthUrl).toContain('Discord-V-Bot');
    });

    it('sollte unterschiedliche Secrets erzeugen', () => {
      const s1 = generate2FASecret('user1', 'Bot');
      const s2 = generate2FASecret('user2', 'Bot');
      expect(s1.base32).not.toBe(s2.base32);
    });
  });

  describe('Backup-Codes', () => {
    it('sollte die gewünschte Anzahl erzeugen', () => {
      const codes = generateBackupCodes(10);
      expect(codes).toHaveLength(10);
    });

    it('sollte Hex-Strings im Uppercase erzeugen', () => {
      const codes = generateBackupCodes(5);
      for (const code of codes) {
        expect(code).toMatch(/^[0-9A-F]{8}$/);
      }
    });

    it('sollte eindeutige Codes erzeugen', () => {
      const codes = generateBackupCodes(100);
      const unique = new Set(codes);
      expect(unique.size).toBe(100);
    });
  });

  describe('CSRF-Token (State-Parameter)', () => {
    it('sollte einen 64-Zeichen-Hex-String erzeugen', () => {
      const token = generateCsrfToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]+$/);
    });

    it('sollte eindeutige Tokens erzeugen', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => generateCsrfToken()));
      expect(tokens.size).toBe(100);
    });
  });

  describe('Nonce (Replay-Schutz)', () => {
    it('sollte eine base64url-kodierte Nonce erzeugen', () => {
      const nonce = generateNonce();
      expect(nonce).toBeTruthy();
      expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('PKCE (Sektion 12)', () => {
    it('sollte Code Verifier und Challenge erzeugen', () => {
      const pkce = generatePKCE();
      expect(pkce.codeVerifier).toBeTruthy();
      expect(pkce.codeChallenge).toBeTruthy();
    });

    it('sollte einen base64url Code Verifier erzeugen', () => {
      const pkce = generatePKCE();
      expect(pkce.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('sollte korrekte S256 Challenge berechnen', () => {
      const pkce = generatePKCE();
      const expectedChallenge = crypto
        .createHash('sha256')
        .update(pkce.codeVerifier)
        .digest('base64url');
      expect(pkce.codeChallenge).toBe(expectedChallenge);
    });
  });
});
