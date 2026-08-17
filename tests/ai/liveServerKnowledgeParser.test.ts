import {
  chooseLiveServerKnowledgeFiles,
  detectServerMissionTemplate,
  isSupportedLiveServerKnowledgeFile,
  parseLiveServerKnowledgeFile,
} from '../../src/modules/ai/liveServerKnowledgeParser';

describe('AI-14 live-server knowledge parser', () => {
  test('serverDZ.cfg persists only allowlisted non-secret runtime fields', () => {
    const docs = parseLiveServerKnowledgeFile({
      path: '/serverDZ.cfg',
      name: 'serverDZ.cfg',
      sha256: 'a'.repeat(64),
      content: [
        'hostname = "Secret Server";',
        'password = "supersecret";',
        'passwordAdmin = "adminsecret";',
        'maxPlayers = 60;',
        'serverTimeAcceleration = 6;',
        'serverNightTimeAcceleration = 4;',
        'template = "dayzOffline.chernarusplus";',
      ].join('\n'),
    });
    const text = docs.map((d) => d.content).join('\n');
    expect(text).toContain('maxPlayers=60');
    expect(text).toContain('serverTimeAcceleration=6');
    expect(text).toContain('template=dayzOffline.chernarusplus');
    expect(text).not.toContain('Secret Server');
    expect(text).not.toContain('supersecret');
    expect(text).not.toContain('adminsecret');
    expect(text).not.toMatch(/passwordAdmin|password=/i);
  });

  test('types.xml normalizes exact live CE values without LLM', () => {
    const docs = parseLiveServerKnowledgeFile({
      path: '/mpmissions/dayzOffline.chernarusplus/db/types.xml',
      name: 'types.xml',
      sha256: 'b'.repeat(64),
      content: `<?xml version="1.0"?><types>
        <type name="M4A1"><nominal>7</nominal><min>3</min><lifetime>7200</lifetime><restock>1200</restock><usage name="Military"/><value name="Tier4"/></type>
        <type name="NailBox"><nominal>42</nominal><min>20</min><lifetime>14400</lifetime><restock>0</restock></type>
      </types>`,
    });
    const text = docs.map((d) => d.content).join('\n');
    expect(text).toContain('type=M4A1 | nominal=7 | min=3 | lifetime=7200 | restock=1200');
    expect(text).toContain('usage=Military');
    expect(text).toContain('value=Tier4');
    expect(text).toContain('type=NailBox | nominal=42 | min=20');
  });

  test('globals.xml omits sensitive-looking keys while keeping safe variables', () => {
    const docs = parseLiveServerKnowledgeFile({
      path: '/mpmissions/dayzOffline.chernarusplus/db/globals.xml',
      name: 'globals.xml',
      sha256: 'c'.repeat(64),
      content: `<variables>
        <var name="ZombieMaxCount" type="0" value="500"/>
        <var name="AdminPassword" type="0" value="leak-me"/>
      </variables>`,
    });
    const text = docs.map((d) => d.content).join('\n');
    expect(text).toContain('global=ZombieMaxCount | value=500');
    expect(text).not.toContain('AdminPassword');
    expect(text).not.toContain('leak-me');
  });

  test('selects duplicate mission files only through the active server template', () => {
    const files = [
      { path: '/serverDZ.cfg', name: 'serverDZ.cfg', content: 'template = "dayzOffline.chernarusplus";' },
      { path: '/mpmissions/dayzOffline.chernarusplus/db/types.xml', name: 'types.xml', content: '<types />' },
      { path: '/mpmissions/dayzOffline.enoch/db/types.xml', name: 'types.xml', content: '<types />' },
    ];
    const chosen = chooseLiveServerKnowledgeFiles(files);
    expect(chosen.map((f) => f.path)).toEqual(expect.arrayContaining([
      '/serverDZ.cfg',
      '/mpmissions/dayzOffline.chernarusplus/db/types.xml',
    ]));
    expect(chosen.map((f) => f.path)).not.toContain('/mpmissions/dayzOffline.enoch/db/types.xml');
  });

  test('fails closed on ambiguous duplicate mission files without a proven active mission', () => {
    const files = [
      { path: '/mpmissions/dayzOffline.chernarusplus/db/types.xml', name: 'types.xml', content: '<types />' },
      { path: '/mpmissions/dayzOffline.enoch/db/types.xml', name: 'types.xml', content: '<types />' },
    ];
    expect(chooseLiveServerKnowledgeFiles(files)).toEqual([]);
  });

  test('rejects logs/backups and arbitrary files from the AI index', () => {
    expect(isSupportedLiveServerKnowledgeFile('/logs/types.xml')).toBe(false);
    expect(isSupportedLiveServerKnowledgeFile('/backup/serverDZ.cfg')).toBe(false);
    expect(isSupportedLiveServerKnowledgeFile('/mpmissions/dayzOffline.sakhal/db/types.xml')).toBe(true);
    expect(isSupportedLiveServerKnowledgeFile('/custom/secrets.json')).toBe(false);
  });

  test('detects the active mission template deterministically', () => {
    expect(detectServerMissionTemplate('template = "dayzOffline.sakhal";')).toBe('dayzOffline.sakhal');
    expect(detectServerMissionTemplate('// template = "dayzOffline.enoch";')).toBeNull();
  });
});
