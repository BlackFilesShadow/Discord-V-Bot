import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const awareness = fs.readFileSync(path.join(root, 'src', 'modules', 'ai', 'guildAwareness.ts'), 'utf8');
const feeds = fs.readFileSync(path.join(root, 'src', 'modules', 'feeds', 'feedManagerV2.ts'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src', 'config.ts'), 'utf8');
const modelRegistry = fs.readFileSync(path.join(root, 'src', 'modules', 'ai', 'modelRegistry.ts'), 'utf8');
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

  it('migriert abgeschaltete AI-Defaults zentral statt providerweise in config.ts', () => {
    expect(config).toContain("import { parseAiProvider, resolveAiModel } from './modules/ai/modelRegistry'");
    expect(config).toContain("groqModel: resolveAiModel('groq'");
    expect(config).toContain("cerebrasModel: resolveAiModel('cerebras'");
    expect(config).toContain("geminiModel: resolveAiModel('gemini'");
    expect(config).toContain("openaiModel: resolveAiModel('openai'");
    expect(config).not.toContain('function resolveGeminiModel()');

    expect(modelRegistry).toContain("groq: 'openai/gpt-oss-120b'");
    expect(modelRegistry).toContain("cerebras: 'gpt-oss-120b'");
    expect(modelRegistry).toContain("gemini: 'gemini-3.6-flash'");
    expect(modelRegistry).toContain("openai: 'gpt-5.6-luna'");
    expect(modelRegistry).toContain("'llama-3.3-70b-versatile': AI_MODEL_DEFAULTS.groq");
    expect(modelRegistry).toContain("'gpt-4': AI_MODEL_DEFAULTS.openai");

    // .env.example bleibt fuer Gemini bereits auf dem produktiven GA-Default;
    // die uebrigen Provider-Defaults werden in einer separaten Setup-/Doku-Etappe
    // synchronisiert, weil dieses Testfile keine Deployment-Dateien veraendert.
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
