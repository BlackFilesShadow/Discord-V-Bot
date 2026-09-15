const mockWarn = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { warn: (...a: unknown[]) => mockWarn(...a) },
}));

import { parseLiveServerKnowledgeFile } from '../../src/modules/ai/liveServerKnowledgeParser';

// Regressionsschutz: ein Parse-Fehler (obwohl die Datei die vorgelagerte
// Syntax-Validierung bestanden haben muss, um hierher zu gelangen) fuehrte
// bisher stillschweigend zu leeren Dokumenten - ohne jedes Logging waere
// eine Divergenz zwischen Validierung und Parser unbemerkt geblieben.
describe('liveServerKnowledgeParser: Logging bei Parse-Fehlern (kein stiller Datenverlust)', () => {
  beforeEach(() => mockWarn.mockClear());

  it('loggt eine Warnung, wenn cfggameplay.json trotz unterstuetztem Dateinamen kein gueltiges JSON ist', () => {
    const docs = parseLiveServerKnowledgeFile({
      path: 'mpmissions/dayzOffline.chernarusplus/cfggameplay.json',
      name: 'cfggameplay.json',
      sha256: 'x'.repeat(64),
      content: '{ this is not valid JSON [[[',
    });

    expect(docs).toEqual([]);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain('JSON.parse fehlgeschlagen');
    expect(mockWarn.mock.calls[0][1]).toMatchObject({ path: expect.stringContaining('cfggameplay.json') });
  });

  it('loggt keine Warnung fuer gueltiges JSON', () => {
    const docs = parseLiveServerKnowledgeFile({
      path: 'mpmissions/dayzOffline.chernarusplus/cfggameplay.json',
      name: 'cfggameplay.json',
      sha256: 'x'.repeat(64),
      content: '{"disableBaseDamage": false}',
    });

    expect(docs.length).toBeGreaterThan(0);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
