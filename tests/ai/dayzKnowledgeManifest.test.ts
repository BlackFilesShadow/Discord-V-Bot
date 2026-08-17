import {
  computeDayzKnowledgeManifestSha256,
  getDayz129CatalogPlatform,
  getDayz129FileMetadata,
  getDayz129Index,
  getDayz129KnowledgeManifest,
  validateDayzKnowledgeIndex,
  type Dayz129Index,
} from '../../src/modules/ai/dayz129Catalog';

function fakeIndex(overrides: Partial<Dayz129Index> = {}): Dayz129Index {
  const file = {
    size: 42,
    sha256: 'a'.repeat(64),
    structure: { root: 'root' },
  };
  return {
    version: '1.29.163451',
    sourceTag: 'USER_ZIPS_1.29.163451',
    verifiedAgainstUserManifest: true,
    maps: {
      chernarus: { mission: 'dayzOffline.chernarusplus', files: { 'db/types.xml': file }, types: {}, events: {} },
      livonia: { mission: 'dayzOffline.enoch', files: { 'db/types.xml': file }, types: {}, events: {} },
      sakhal: { mission: 'dayzOffline.sakhal', files: { 'db/types.xml': file }, types: {}, events: {} },
    },
    allFileBasenames: ['types.xml'],
    allRelativePaths: ['db/types.xml'],
    allTypeNames: [],
    allEventNames: [],
    ...overrides,
  };
}

describe('AI-12 DayZ Knowledge 2.0 manifest', () => {
  it('validiert den real eingebetteten DayZ-1.29-Katalog samt Datei-SHA256s', () => {
    const index = getDayz129Index();
    const issues = validateDayzKnowledgeIndex(index);
    expect(issues).toEqual([]);

    const manifest = getDayz129KnowledgeManifest();
    expect(manifest.game).toBe('DayZ');
    expect(manifest.version).toBe(index.version);
    expect(manifest.versionFamily).toMatch(/^1\.29(?:$|\.)/);
    expect(manifest.sourceTag).toBe('USER_ZIPS_1.29.163451');
    expect(manifest.validity).toBe('VALID');
    expect(manifest.fileCount).toBeGreaterThan(0);
    expect(manifest.maps.map((entry) => entry.map).sort()).toEqual(['chernarus', 'livonia', 'sakhal']);
    expect(manifest.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('klassifiziert die Plattform konservativ als UNKNOWN statt sie zu erfinden', () => {
    expect(getDayz129CatalogPlatform()).toBe('UNKNOWN');
    expect(getDayz129KnowledgeManifest().platform).toBe('UNKNOWN');
  });

  it('berechnet denselben Manifest-Hash deterministisch und bindet Aenderungen ein', () => {
    const index = fakeIndex();
    const first = computeDayzKnowledgeManifestSha256(index);
    const second = computeDayzKnowledgeManifestSha256(index);
    expect(first).toBe(second);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    const changed = fakeIndex();
    changed.maps.chernarus.files['db/types.xml'] = {
      ...changed.maps.chernarus.files['db/types.xml'],
      sha256: 'b'.repeat(64),
    };
    expect(computeDayzKnowledgeManifestSha256(changed)).not.toBe(first);
  });

  it('faellt bei manipuliertem Datei-Hash fail-closed auf INVALID', () => {
    const index = fakeIndex();
    index.maps.livonia.files['db/types.xml'] = {
      ...index.maps.livonia.files['db/types.xml'],
      sha256: 'not-a-sha256',
    };
    const issues = validateDayzKnowledgeIndex(index);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'FILE_SHA256_INVALID', map: 'livonia', path: 'db/types.xml' }),
    ]));
  });

  it('erkennt fehlende Pflichtkarten statt einen Teilkatalog als gueltig zu behandeln', () => {
    const index = fakeIndex();
    delete (index.maps as Partial<Dayz129Index['maps']>).sakhal;
    expect(validateDayzKnowledgeIndex(index)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'MAP_MISSING', map: 'sakhal' }),
    ]));
  });

  it('liefert reale File-Metadaten mit Version, Quelle und vorhandenem Kataloghash', () => {
    const index = getDayz129Index();
    const expected = index.maps.chernarus.files['db/types.xml'];
    expect(expected).toBeDefined();

    const meta = getDayz129FileMetadata('chernarus', 'db/types.xml');
    expect(meta).not.toBeNull();
    expect(meta).toMatchObject({
      map: 'chernarus',
      path: 'db/types.xml',
      version: index.version,
      sourceTag: 'USER_ZIPS_1.29.163451',
      platform: 'UNKNOWN',
      size: expected.size,
      sha256: expected.sha256.toLowerCase(),
    });
    expect(meta!.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('gibt fuer nicht indexierte Dateien keine erfundene Metadatenquelle aus', () => {
    expect(getDayz129FileMetadata('chernarus', 'db/does-not-exist.xml')).toBeNull();
  });
});
