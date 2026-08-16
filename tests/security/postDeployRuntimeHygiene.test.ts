import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const awareness = fs.readFileSync(path.join(root, 'src', 'modules', 'ai', 'guildAwareness.ts'), 'utf8');
const feeds = fs.readFileSync(path.join(root, 'src', 'modules', 'feeds', 'feedManagerV2.ts'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src', 'config.ts'), 'utf8');
const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(absolute));
    else if (entry.isFile() && absolute.endsWith('.ts')) out.push(absolute);
  }
  return out;
}

describe('Post-deploy runtime hygiene', () => {
  it('verwendet die aktuelle Discord-Pin-API', () => {
    expect(awareness).toContain('fetchPins()');
    expect(awareness).not.toContain('fetchPinned()');
  });

  it('verwendet keine deprecated ephemeral:true Interaction-Option mehr', () => {
    for (const file of sourceFiles(path.join(root, 'src'))) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toContain('ephemeral: true');
    }
  });

  it('migriert abgeschaltete Gemini-2.0-Defaults kontrolliert auf aktuelle Ersatzmodelle', () => {
    expect(config).toContain('function resolveGeminiModel()');
    expect(config).toContain("configured === 'gemini-2.0-flash'");
    expect(config).toContain("return 'gemini-3.6-flash'");
    expect(config).toContain("return 'gemini-3.1-flash-lite'");
    expect(config).toContain('geminiModel: resolveGeminiModel()');
    expect(env).toContain('GEMINI_MODEL=gemini-3.6-flash');
    expect(env).not.toContain('GEMINI_MODEL=gemini-2.0-flash');
  });

  it('behandelt bekannte Feed-Konfigurationsfehler als Backoff-Warnung statt Prozessfehler', () => {
    expect(feeds).toContain('function isFeedConfigurationError');
    expect(feeds).toContain('Twitch-Credentials fehlen');
    expect(feeds).toContain('Ziel-Channel ist nicht erreichbar');
    expect(feeds).toContain('Konfiguration unvollstaendig/ungueltig; Retry nach Backoff');
    expect(feeds).toContain('feedBackoff.set');
  });
});
