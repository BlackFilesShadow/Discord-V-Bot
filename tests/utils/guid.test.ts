import { generateGuid, isValidGuid, generateSecureId } from '../../src/utils/guid';

describe('GUID Utility (Sektion 1)', () => {
  describe('generateGuid', () => {
    it('sollte eine gültige UUIDv4 erzeugen', () => {
      const guid = generateGuid();
      expect(isValidGuid(guid)).toBe(true);
    });

    it('sollte eindeutige GUIDs erzeugen', () => {
      const guids = new Set(Array.from({ length: 1000 }, () => generateGuid()));
      expect(guids.size).toBe(1000);
    });

    it('sollte dem UUIDv4-Format entsprechen', () => {
      const guid = generateGuid();
      expect(guid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });
  });

  describe('isValidGuid', () => {
    it('sollte gültige UUIDs akzeptieren', () => {
      expect(isValidGuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    });

    it('sollte ungültige Strings ablehnen', () => {
      expect(isValidGuid('')).toBe(false);
      expect(isValidGuid('not-a-guid')).toBe(false);
      expect(isValidGuid('12345')).toBe(false);
    });
  });

  describe('generateSecureId', () => {
    it('sollte einen Hex-String der richtigen Länge erzeugen', () => {
      const id = generateSecureId(32);
      expect(id).toHaveLength(64); // 32 bytes = 64 hex chars
      expect(id).toMatch(/^[0-9a-f]+$/);
    });

    it('sollte eindeutige IDs erzeugen', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateSecureId()));
      expect(ids.size).toBe(100);
    });
  });
});
