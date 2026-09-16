/**
 * Regressionsschutz fuer die SHA-256-Selbstpruefung des generierten DayZ-1.29
 * German-Names-Payloads (aus Bohemias eigener stringtable.csv, siehe
 * scripts/generate_dayz129_stringtable.py). Analog zu
 * dayz129IndexIntegrity.test.ts: eine kuenftige Beschaedigung des
 * eingebetteten Payloads muss sofort und fail-closed auffallen, statt still
 * eine leere oder falsche Uebersetzungstabelle zu laden.
 */
jest.mock('../../src/modules/ai/generated/dayz129GermanNamesData', () => ({
  DAYZ129_GERMAN_NAMES_GZIP_BASE64: 'AAAA',
  DAYZ129_GERMAN_NAMES_GZIP_BASE64_SHA256: 'not-the-real-hash',
}));

describe('DayZ 1.29 German-names payload integrity', () => {
  test('getDayz129GermanNames() fails closed when the embedded payload does not match its own SHA-256', () => {
    const { getDayz129GermanNames } = require('../../src/modules/ai/dayz129CatalogBase');
    expect(() => getDayz129GermanNames()).toThrow(/beschaedigt|SHA-256/i);
  });
});
