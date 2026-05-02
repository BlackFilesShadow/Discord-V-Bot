import { detectTypesXmlValueViolations } from '../../src/modules/ai/nitradoHelp';

describe('detectTypesXmlValueViolations', () => {
  it('findet keine Verletzung bei realistischen XML-Attributen', () => {
    const ok = '<type name="M4A1"><nominal>10</nominal><min>5</min></type> nominal="15" min="8"';
    expect(detectTypesXmlValueViolations(ok)).toEqual([]);
  });

  it('erkennt nominal="200" als Verletzung', () => {
    const bad = 'Beispiel: nominal="200" min="100"';
    const v = detectTypesXmlValueViolations(bad);
    expect(v.length).toBeGreaterThanOrEqual(2);
    expect(v.some((x) => x.includes('200'))).toBe(true);
  });

  it('erkennt unrealistische Markdown-Tabellen-Werte', () => {
    const bad = [
      '| Item | nominal | min | restock |',
      '|------|---------|-----|---------|',
      '| Wasser | 350 | 180 | 300 |',
      '| Munition | 200 | 110 | 300 |',
    ].join('\n');
    const v = detectTypesXmlValueViolations(bad);
    expect(v.length).toBeGreaterThanOrEqual(4); // 350,180,200,110
  });

  it('akzeptiert die offizielle Referenz-Tabelle (alles <=25)', () => {
    const ok = [
      '| Item-Kategorie | nominal | min |',
      '|---|---|---|',
      '| Seltene Waffen | 10 | 5 |',
      '| Normale Waffen | 15 | 8 |',
      '| Nahrung | 20 | 10 |',
    ].join('\n');
    expect(detectTypesXmlValueViolations(ok)).toEqual([]);
  });

  it('liefert leeres Array bei leerem Input', () => {
    expect(detectTypesXmlValueViolations('')).toEqual([]);
  });
});
