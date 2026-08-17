import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('AI-12 DayZ Knowledge 2.0 architecture', () => {
  it('bindet Version, Plattform, Quelle, Manifest-Hash und Gueltigkeit zentral', () => {
    const source = read('src/modules/ai/dayzKnowledgeManifest.ts');
    expect(source).toContain('version: index.version');
    expect(source).toContain('platform: getDayz129CatalogPlatform()');
    expect(source).toContain('sourceTag: index.sourceTag');
    expect(source).toContain('manifestSha256: computeDayzKnowledgeManifestSha256(index)');
    expect(source).toContain("validity: issues.length === 0 ? 'VALID' : 'INVALID'");
    expect(source).toContain('verifiedAgainstUserManifest: isDayzUserManifestVerified(index)');
  });

  it('erfindet fuer den eingebetteten ZIP-Katalog keine unbelegte Plattform', () => {
    const source = read('src/modules/ai/dayzKnowledgeManifest.ts');
    expect(source).toMatch(/function getDayz129CatalogPlatform[\s\S]*return 'UNKNOWN';/);
    expect(source).not.toMatch(/function getDayz129CatalogPlatform[\s\S]{0,200}return '(PC|XBOX|PLAYSTATION|CROSS_PLATFORM)';/);
  });

  it('akzeptiert historischen undefined-Status nur bei exakt kanonischer User-ZIP-Provenance', () => {
    const source = read('src/modules/ai/dayzKnowledgeManifest.ts');
    expect(source).toContain("if (index.verifiedAgainstUserManifest === true) return true;");
    expect(source).toContain("if (index.verifiedAgainstUserManifest === false) return false;");
    expect(source).toContain("index.sourceTag === CANONICAL_SOURCE_TAG");
    expect(source).toContain('DAYZ129_PROVENANCE.valueAndStructureSource === CANONICAL_USER_ZIP_PROVENANCE');
  });

  it('bindet den Gesamt-Hash an Datei-SHA256 und Provenance', () => {
    const source = read('src/modules/ai/dayzKnowledgeManifest.ts');
    expect(source).toContain('file.sha256.toLowerCase()');
    expect(source).toContain('valueAndStructureSource=');
    expect(source).toContain('officialSemanticReference=');
    expect(source).toContain('sourceRule=');
    expect(source).toContain('verifiedAgainstUserManifest=');
  });

  it('exportiert den Manifest-Vertrag ueber den kanonischen DayZ-Katalog', () => {
    const catalog = read('src/modules/ai/dayz129Catalog.ts');
    expect(catalog).toContain('getDayz129KnowledgeManifest');
    expect(catalog).toContain('getDayz129FileMetadata');
    expect(catalog).toContain('validateDayzKnowledgeIndex');
  });
});
