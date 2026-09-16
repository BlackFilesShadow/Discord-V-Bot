/**
 * Regressionsschutz fuer die SHA-256-Selbstpruefung des eingebetteten
 * DayZ-1.29-Index-Payloads. Der Payload wurde in diesem Repo schon einmal
 * spaet im komprimierten Stream beschaedigt und dabei still als
 * (teilweise falsche) Wissensbasis geladen, bevor der Fehler auffiel. Diese
 * Selbstpruefung muss eine kuenftige Beschaedigung sofort und fail-closed
 * erkennen, statt sie zu ignorieren.
 */
jest.mock('../../src/modules/ai/generated/dayz129IndexData', () => ({
  DAYZ129_INDEX_GZIP_BASE64: 'AAAA',
  DAYZ129_INDEX_GZIP_BASE64_SHA256: 'not-the-real-hash',
}));

describe('DayZ 1.29 index payload integrity', () => {
  test('getDayz129Index() fails closed when the embedded payload does not match its own SHA-256', () => {
    const { getDayz129Index } = require('../../src/modules/ai/dayz129CatalogBase');
    expect(() => getDayz129Index()).toThrow(/beschaedigt|SHA-256/i);
  });
});
