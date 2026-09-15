import { formatSearchResultsForPrompt } from '../../src/modules/ai/webSearch';
import { UNTRUSTED_CONTEXT_POLICY } from '../../src/modules/ai/untrustedContext';

describe('formatSearchResultsForPrompt (Untrusted-Context-Firewall fuer Web-Suche)', () => {
  it('umschliesst die externen Suchtreffer mit der Untrusted-Context-Policy', () => {
    const block = formatSearchResultsForPrompt([
      { source: 'Wikipedia', title: 'Testartikel', snippet: 'Ein Snippet-Inhalt.', url: 'https://example.local/x' },
    ]);

    expect(block).not.toBeNull();
    expect(block).toContain(UNTRUSTED_CONTEXT_POLICY);
    expect(block).toContain('UNTRUSTED_CONTEXT_DATA_JSON:\n');
    // Die Snippet-Rohdaten muessen innerhalb des JSON-Payloads stehen, nicht
    // als freier Systemtext davor/danach.
    expect(block).toContain('Ein Snippet-Inhalt.');
  });

  it('haelt die eigene Nutzungsanleitung ausserhalb des Untrusted-Wrappers (bleibt befolgbare Systemanweisung)', () => {
    const block = formatSearchResultsForPrompt([
      { source: 'DuckDuckGo', title: 'Titel', snippet: 'Inhalt.' },
    ]);

    expect(block).not.toBeNull();
    const wrapperEnd = block!.indexOf('UNTRUSTED_CONTEXT_DATA_JSON:\n');
    const jsonLineEnd = block!.indexOf('\n', wrapperEnd + 'UNTRUSTED_CONTEXT_DATA_JSON:\n'.length);
    const afterWrapper = block!.slice(jsonLineEnd);
    expect(afterWrapper).toContain('ANWEISUNGEN:');
    expect(afterWrapper).toContain('Erfinde keine Fakten');
  });

  it('gibt weiterhin null bei leeren Ergebnissen zurueck', () => {
    expect(formatSearchResultsForPrompt([])).toBeNull();
  });
});
