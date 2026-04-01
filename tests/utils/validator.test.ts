import { validateXml, validateJson } from '../../src/utils/validator';

describe('Validator Utility (Sektion 2)', () => {
  describe('validateXml', () => {
    it('sollte gültiges XML akzeptieren', () => {
      const xml = '<?xml version="1.0"?><root><item>test</item></root>';
      const report = validateXml(xml);
      expect(report.isValid).toBe(true);
      expect(report.fileType).toBe('xml');
      expect(report.errors).toHaveLength(0);
    });

    it('sollte ungültiges XML ablehnen', () => {
      const xml = '<root><item>unclosed';
      const report = validateXml(xml);
      expect(report.isValid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
    });

    it('sollte leeres XML ablehnen', () => {
      const report = validateXml('');
      expect(report.isValid).toBe(false);
    });

    it('sollte Vorschläge bei Fehlern liefern', () => {
      const xml = '<root><item></root>';
      const report = validateXml(xml);
      expect(report.isValid).toBe(false);
      expect(report.suggestions.length).toBeGreaterThan(0);
    });
  });

  describe('validateJson', () => {
    it('sollte gültiges JSON akzeptieren', () => {
      const json = '{"name": "test", "value": 42}';
      const report = validateJson(json);
      expect(report.isValid).toBe(true);
      expect(report.fileType).toBe('json');
      expect(report.errors).toHaveLength(0);
    });

    it('sollte ungültiges JSON ablehnen', () => {
      const json = '{name: invalid}';
      const report = validateJson(json);
      expect(report.isValid).toBe(false);
      expect(report.errors.length).toBeGreaterThan(0);
    });

    it('sollte leeren String ablehnen', () => {
      const report = validateJson('');
      expect(report.isValid).toBe(false);
    });

    it('sollte verschachteltes JSON korrekt validieren', () => {
      const json = JSON.stringify({
        level1: { level2: { level3: [1, 2, 3] } },
        array: [{ a: 1 }, { b: 2 }],
      });
      const report = validateJson(json);
      expect(report.isValid).toBe(true);
    });

    it('sollte Strukturinfos liefern', () => {
      const json = '{"a": 1, "b": [1,2,3]}';
      const report = validateJson(json);
      expect(report.isValid).toBe(true);
      expect(report.structureInfo).toBeDefined();
    });
  });
});
