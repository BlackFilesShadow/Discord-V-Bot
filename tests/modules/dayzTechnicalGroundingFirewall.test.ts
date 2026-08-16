import { answerDayz129CatalogQuestion } from '../../src/modules/ai/dayz129Catalog';

describe('DayZ technical grounding preflight firewall', () => {
  it('preserves deterministic catalog answers before the generic firewall', () => {
    const result = answerDayz129CatalogQuestion('Wie heißt der Classname M4A1?');
    expect(result?.topic).toBe('type');
    expect(result?.answer).toContain('`M4A1`');
    expect(result?.ids).toContain('dayz129:type:M4A1');
  });

  it('answers maxPlayers without inventing a numeric default', () => {
    const result = answerDayz129CatalogQuestion('Was muss ich bei DayZ am Server für maxPlayers einstellen?');
    expect(result?.answer).toContain('`maxPlayers`');
    expect(result?.answer).toContain('keinen universellen Vanilla-Zahlenwert');
    expect(result?.answer).not.toMatch(/maxPlayers\s*=\s*\d+/i);
  });

  it('answers server time acceleration without invented mandatory values', () => {
    const result = answerDayz129CatalogQuestion('Wie stelle ich in DayZ serverTimeAcceleration und serverNightTimeAcceleration ein?');
    expect(result?.answer).toContain('`serverTimeAcceleration`');
    expect(result?.answer).toContain('`serverNightTimeAcceleration`');
    expect(result?.answer).toContain('keinen angeblichen Vanilla-Pflichtwert');
    expect(result?.answer).not.toMatch(/(?:serverTimeAcceleration|serverNightTimeAcceleration)\s*=\s*\d+/i);
  });

  it('keeps Build Anywhere on verified 1.29 parameters', () => {
    const result = answerDayz129CatalogQuestion('Wie aktiviere ich Build Anywhere in DayZ?');
    expect(result?.answer).toContain('`cfggameplay.json`');
    expect(result?.answer).toContain('`enableCfgGameplayFile = 1;`');
    expect(result?.answer).toContain('`disableIsPlacementPermittedCheck`');
    expect(result?.answer).not.toContain('enableBuilding');
    expect(result?.answer).not.toContain('BuildDistance');
  });

  it('returns only verified mission templates for map switching', () => {
    const result = answerDayz129CatalogQuestion('Wie kann ich bei DayZ die Map bzw. Mission wechseln?');
    expect(result?.answer).toContain('`dayzOffline.chernarusplus`');
    expect(result?.answer).toContain('`dayzOffline.enoch`');
    expect(result?.answer).toContain('`dayzOffline.sakhal`');
  });

  it('does not guess mod-specific paths or dependencies', () => {
    const result = answerDayz129CatalogQuestion('Wie installiere ich Mods auf meinem DayZ Server?');
    expect(result?.answer).toContain('`-mod=`');
    expect(result?.answer).toContain('jeweiligen Mod-Dokumentation');
    expect(result?.answer).not.toContain('@CF');
  });

  it('routes generic weather changes to the verified weather file without values', () => {
    const result = answerDayz129CatalogQuestion('Wie ändere ich das Wetter in DayZ?');
    expect(result?.answer).toContain('`cfgweather.xml`');
    expect(result?.answer).toContain('Chernarus');
    expect(result?.answer).toContain('Livonia');
    expect(result?.answer).toContain('Sakhal');
    expect(result?.answer).not.toMatch(/rain\s*=\s*[0-9.]+/i);
  });

  it('fails closed for unsupported technical config concepts instead of reaching free model guessing', () => {
    const result = answerDayz129CatalogQuestion('Wie ändere ich die Stamina in DayZ?');
    expect(result?.topic).toBe('file');
    expect(result?.ids).toContain('dayz129:technical:grounding-required');
    expect(result?.answer).toContain('Ich rate keine Server-Einstellung');
    expect(result?.answer).not.toMatch(/stamina[A-Za-z0-9_]*\s*[=:]\s*\d+/i);
  });

  it('fails closed for broad loot tuning without fabricating numbers or filenames', () => {
    const result = answerDayz129CatalogQuestion('Wie erhöhe ich den Loot auf meinem DayZ Server?');
    expect(result?.ids).toContain('dayz129:technical:grounding-required');
    expect(result?.answer).toContain('konkrete Datei');
    expect(result?.answer).not.toMatch(/nominal\s*=\s*\d+/i);
    expect(result?.answer).not.toContain('lootcategories.xml');
  });

  it('does not hijack foreign config-file questions without DayZ context', () => {
    expect(answerDayz129CatalogQuestion('Was macht die tsconfig.json?')).toBeNull();
    expect(answerDayz129CatalogQuestion('Erklär mir pom.xml')).toBeNull();
  });

  it('still recognizes known DayZ files without requiring the word DayZ', () => {
    const result = answerDayz129CatalogQuestion('Was macht die cfgweather.xml?');
    expect(result?.topic).toBe('file');
    expect(result?.answer).toContain('`cfgweather.xml`');
  });

  it('does not hijack ordinary DayZ gameplay questions', () => {
    const result = answerDayz129CatalogQuestion('Wie funktioniert Blutverlust in DayZ?');
    expect(result).toBeNull();
  });
});
