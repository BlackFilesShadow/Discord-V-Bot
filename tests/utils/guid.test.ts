import { generateGuid, isValidGuid, generateSecureId, isValidBattleyeGuid } from '../../src/utils/guid';

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

  describe('isValidBattleyeGuid (Spec 13 — GUID-strict)', () => {
    it('sollte echte BattlEye-GUIDs akzeptieren (32 hex)', () => {
      expect(isValidBattleyeGuid('a1b2c3d4e5f6789012345678abcdef00')).toBe(true);
      expect(isValidBattleyeGuid('AbCd1234EfGh5678IjKl9012MnOp3456')).toBe(true);
    });

    it('sollte tolerante Modded-Formate (8-64 alphanum + _-) akzeptieren', () => {
      expect(isValidBattleyeGuid('abc12345')).toBe(true);
      expect(isValidBattleyeGuid('Player_GUID-001')).toBe(true);
    });

    it('sollte Muell ablehnen', () => {
      expect(isValidBattleyeGuid('')).toBe(false);
      expect(isValidBattleyeGuid('Unknown')).toBe(false);
      expect(isValidBattleyeGuid('N/A')).toBe(false);
      expect(isValidBattleyeGuid('null')).toBe(false);
      expect(isValidBattleyeGuid('false')).toBe(false);
      expect(isValidBattleyeGuid('0')).toBe(false);
      expect(isValidBattleyeGuid('   ')).toBe(false);
      expect(isValidBattleyeGuid('short')).toBe(false); // < 8 chars
      expect(isValidBattleyeGuid('a'.repeat(65))).toBe(false); // > 64 chars
      expect(isValidBattleyeGuid('hat spaces drin')).toBe(false);
      expect(isValidBattleyeGuid('with;injection')).toBe(false);
      expect(isValidBattleyeGuid(undefined)).toBe(false);
      expect(isValidBattleyeGuid(123)).toBe(false);
      expect(isValidBattleyeGuid(null)).toBe(false);
    });
  });
});
