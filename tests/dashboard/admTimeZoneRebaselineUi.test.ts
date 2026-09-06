import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'dashboard-ui/src/components/AdmTimeZoneCard.tsx'),
  'utf8',
);

describe('ADM timezone rebaseline dashboard gate', () => {
  it('allows an explicit same-timezone submit when a timezone is already stored', () => {
    expect(source).toContain('const rebaselineOnly = !dirty && stored.length > 0;');
    expect(source).toContain('const canSubmit = dirty || rebaselineOnly;');
    expect(source).toContain('disabled={saving || !canSubmit}');
    expect(source).toContain("{rebaselineOnly ? 'Zeitbasis neu prüfen' : 'Zeitzone speichern'}");
    expect(source).not.toContain('disabled={saving || !dirty}');
  });
});
