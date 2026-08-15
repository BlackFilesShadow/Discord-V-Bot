import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

function walkTs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walkTs(full);
    return entry.isFile() && full.endsWith('.ts') && !full.includes(`${path.sep}__tests__${path.sep}`) ? [full] : [];
  });
}

describe('current bot information surfaces', () => {
  const aiCatalog = read('src/modules/ai/commandCatalog.ts');
  const aiHandler = read('src/modules/ai/aiHandler.ts');
  const about = read('src/commands/about.ts');
  const botInfo = read('src/content/botInfo.ts');
  const help = read('src/commands/user/help.ts');
  const readme = read('README.md');
  const security = read('SECURITY.md');
  const architecture = read('docs/ARCHITECTURE.md');
  const performance = read('docs/PERFORMANCE.md');

  it('haelt entfernte Admin/DEV-Slash-Beispiele aus Bot-Antworten fern', () => {
    expect(aiCatalog).not.toContain("name: '/autorole");
    expect(aiCatalog).not.toContain("name: '/admin-");
    expect(aiCatalog).not.toContain("name: '/dev-");
    expect(aiHandler).not.toContain('Beispiele wie /ai-trigger');
    expect(aiHandler).not.toContain('/ticket, /feed');
    expect(aiHandler).toContain('Bot-Admin- und DEV-Verwaltung ist Dashboard-only');
  });

  it('kennt aktuelle Discord-Funktionsgruppen', () => {
    for (const cmd of [
      '/help', '/feedback', '/erinnerung setzen', '/fraktionen', '/balance',
      '/slot', '/whitelist', '/server-ban', '/perm-add', '/upload', '/mypackages list',
    ]) {
      expect(aiCatalog).toContain(`name: '${cmd}'`);
    }
  });

  it('dokumentiert keinen AI-Slash-Basisnamen ohne reale Command-Definition', () => {
    const source = walkTs(path.resolve(process.cwd(), 'src/commands'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const defined = new Set([...source.matchAll(/\.setName\(\s*['"]([a-z0-9-]+)['"]\s*\)/g)].map((m) => m[1]));
    const documented = [...aiCatalog.matchAll(/name:\s*['"]\/([a-z0-9-]+)/g)].map((m) => m[1]);
    const missing = [...new Set(documented.filter((name) => !defined.has(name)))];
    expect(missing).toEqual([]);
  });

  it('leitet Hersteller-Uploadinformationen aus der echten Config ab statt alte 2GB zu behaupten', () => {
    expect(aiCatalog).toContain('config.upload.maxFileSizeBytes');
    expect(aiCatalog).toContain('config.upload.allowedExtensions');
    expect(aiCatalog).not.toMatch(/2\s*GB/i);
    expect(botInfo).toContain('config.upload.maxFileSizeBytes');
  });

  it('nutzt fuer Bot-Selbstauskunft eine einzige kanonische Quelle ohne Runtime-Markdown', () => {
    expect(about).not.toContain('about.md');
    expect(about).toContain("from '../content/botInfo'");
    expect(botInfo).toContain("import { BOT_DEVELOPER }");
    expect(botInfo).toContain('/help');
    expect(botInfo).toContain('Bot-Admin-/DEV-Werkzeuge');
    expect(botInfo).toContain('Hersteller');
  });

  it('/help erklaert die aktuelle Dashboard-Trennung', () => {
    expect(help).toContain('Aktuelle Discord-Commands');
    expect(help).toContain('Bot-Admin & DEV: Web-Dashboard');
    expect(help).toContain('Hersteller-Slash-Funktionen bleiben in Discord');
  });

  it('kanonische Doku beschreibt keinen alten globalen Admin/DEV-Slash-Betrieb mehr', () => {
    for (const doc of [readme, security, architecture, performance]) {
      expect(doc).toContain('Dashboard');
      expect(doc).not.toMatch(/\/admin-aimodels\b/);
      expect(doc).not.toMatch(/\/dev-login\b/);
      expect(doc).not.toMatch(/\/dev-reload\b/);
    }
    expect(readme).toContain('Void_Architect');
    expect(security).toMatch(/verifiziert\w* Step-Up/i);
    expect(architecture).toContain('ADM V2');
    expect(performance).toContain('METRICS_ENABLED=true');
    expect(performance).toContain('METRICS_TOKEN');
    expect(performance).not.toContain('/translate-post');
  });
});
