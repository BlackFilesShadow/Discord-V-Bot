import {
  generateOneTimePassword,
  hashPassword,
  verifyPassword,
  generateSecureToken,
} from '../../src/utils/password';

describe('Password Utility (Sektion 1 & 5)', () => {
  describe('generateOneTimePassword', () => {
    it('sollte ein Passwort der gewünschten Länge erzeugen', () => {
      const otp = generateOneTimePassword(48);
      expect(otp).toHaveLength(48);
    });

    it('sollte Groß-/Kleinbuchstaben, Zahlen und Sonderzeichen enthalten', () => {
      const otp = generateOneTimePassword(48);
      expect(otp).toMatch(/[A-Z]/);
      expect(otp).toMatch(/[a-z]/);
      expect(otp).toMatch(/[0-9]/);
      expect(otp).toMatch(/[!@#$%^&*()\-_=+\[\]{}|;:,.<>?]/);
    });

    it('sollte eindeutige Passwörter erzeugen', () => {
      const passwords = new Set(Array.from({ length: 100 }, () => generateOneTimePassword()));
      expect(passwords.size).toBe(100);
    });

    it('sollte die Standard-Länge von 48 verwenden', () => {
      const otp = generateOneTimePassword();
      expect(otp).toHaveLength(48);
    });
  });

  describe('hashPassword / verifyPassword (Argon2id)', () => {
    it('sollte ein Passwort korrekt hashen und verifizieren', async () => {
      const password = 'TestPasswort123!';
      const hash = await hashPassword(password);

      expect(hash).toBeTruthy();
      expect(hash).not.toBe(password);
      expect(await verifyPassword(hash, password)).toBe(true);
    });

    it('sollte bei falschem Passwort false zurückgeben', async () => {
      const hash = await hashPassword('korrekt');
      expect(await verifyPassword(hash, 'falsch')).toBe(false);
    });

    it('sollte Argon2id verwenden', async () => {
      const hash = await hashPassword('test');
      expect(hash).toMatch(/^\$argon2id\$/);
    });

    it('sollte unterschiedliche Hashes für gleiche Passwörter erzeugen (Salt)', async () => {
      const password = 'SamePassword!';
      const hash1 = await hashPassword(password);
      const hash2 = await hashPassword(password);
      expect(hash1).not.toBe(hash2);
      expect(await verifyPassword(hash1, password)).toBe(true);
      expect(await verifyPassword(hash2, password)).toBe(true);
    });
  });

  describe('generateSecureToken', () => {
    it('sollte einen base64url-kodierten Token erzeugen', () => {
      const token = generateSecureToken();
      expect(token).toBeTruthy();
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('sollte eindeutige Tokens erzeugen', () => {
      const tokens = new Set(Array.from({ length: 100 }, () => generateSecureToken()));
      expect(tokens.size).toBe(100);
    });
  });
});
