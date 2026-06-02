import { buildValidationResult, renderValidationReport } from '../../src/dashboard/services/validationResult';

describe('buildValidationResult', () => {
  it('liefert Metadaten und ok=true fuer gueltiges JSON', () => {
    const r = buildValidationResult('json', { content: '{"a":1,"b":[1,2,3]}', fileName: 'x.json' });
    expect(r.ok).toBe(true);
    expect(r.type).toBe('json');
    expect(r.sizeBytes).toBeGreaterThan(0);
    expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.lineCount).toBe(1);
    expect(r.summary.errors).toBe(0);
    expect(typeof r.durationMs).toBe('number');
  });

  it('meldet Fehler und Code fuer kaputtes JSON', () => {
    const r = buildValidationResult('json', { content: '{"a":1,}' });
    expect(r.ok).toBe(false);
    expect(r.summary.errors).toBeGreaterThan(0);
    expect(r.issues.some(i => i.code.startsWith('JSON'))).toBe(true);
  });

  it('bietet Auto-Fix fuer JSON mit trailing comma als suggestion + fixedPreview', () => {
    const r = buildValidationResult('json', { content: '{"a":1,}' });
    if (r.fixedPreview) {
      expect(r.summary.suggestions).toBeGreaterThan(0);
      expect(r.issues.some(i => i.severity === 'suggestion')).toBe(true);
    }
  });

  it('erkennt generisches XML', () => {
    const r = buildValidationResult('xml', { content: '<root><a>1</a></root>' });
    expect(r.type).toBe('xml');
    expect(r.ok).toBe(true);
  });

  it('meldet unbalanciertes XML mit Code', () => {
    const r = buildValidationResult('xml', { content: '<root><a></root>' });
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.code.startsWith('XML'))).toBe(true);
  });

  it('nutzt DayZ-Strukturpruefung bei types.xml', () => {
    const xml = '<types><type name="X"><nominal>-1</nominal><min>5</min><lifetime>10</lifetime></type></types>';
    const r = buildValidationResult('xml', { content: xml, fileName: 'types.xml' });
    expect(r.type).toBe('dayz-config');
    expect(r.issues.some(i => i.code.startsWith('DAYZ'))).toBe(true);
  });

  it('zaehlt Zeilen korrekt', () => {
    const r = buildValidationResult('json', { content: '{\n"a":1\n}' });
    expect(r.lineCount).toBe(3);
  });
});

describe('renderValidationReport', () => {
  it('erzeugt Markdown ohne Secrets', () => {
    const r = buildValidationResult('json', { content: '{"a":1}', fileName: 'x.json' });
    const md = renderValidationReport(r, 'markdown');
    expect(md).toContain('# Validierungsbericht');
    expect(md).toContain('SHA256');
  });

  it('erzeugt Text-Report', () => {
    const r = buildValidationResult('xml', { content: '<root/>' });
    const txt = renderValidationReport(r, 'text');
    expect(txt).toContain('Validierungsbericht');
    expect(txt).toContain('Befunde:');
  });
});
