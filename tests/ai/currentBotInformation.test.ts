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

const CANONICAL_COMMAND_RENAMES: Readonly<Record<string, string>> = {
  whitelist: 'whitelist-antrag',
  'wl-add': 'whitelist-add',
  'wl-remove': 'whitelist-remove',
  'wl-list': 'whitelist',
};

describe('current bot information surfaces', () => {
  const aiCatalog = read('src/modules/ai/commandCatalog.ts');
  const aiHandler = read('src/modules/ai/aiHandler.ts');
  const aiTriggers = read('src/modules/ai/triggers.ts');
  const about = read('src/commands/about.ts');
  const botInfo = read('src/content/botInfo.ts');
  const help = read('src/commands/user/help.ts');
  const handler = read('src/commands/handler.ts');
  const readme = read('README.md');
  const security = read('SECURITY.md');
  const architecture = read('docs/ARCHITECTURE.md');
  const performance = read('docs/PERFORMANCE.md');
  const monitoring = read('docs/monitoring/README.md');
  const alerts = read('docs/monitoring/prometheus-alerts.yml');
  const contributing = read('CONTRIBUTING.md');
  const packageJson = JSON.parse(read('package.json')) as { description?: string; scripts?: Record<string, string> };

  it('haelt entfernte Admin/DEV-Slash-Beispiele aus Bot-Antworten fern', () => {
    expect(aiCatalog).not.toContain("name: '/autorole");
    expect(aiCatalog).not.toContain("name: '/admin-");
    expect(aiCatalog).not.toContain("name: '/dev-");
    expect(aiHandler).not.toContain('Beispiele wie /ai-trigger');
    expect(aiHandler).not.toContain('/ticket, /feed');
    expect(aiHandler).toContain('Bot-Admin- und DEV-Verwaltung ist Dashboard-only');
    expect(aiTriggers).not.toContain('User-, Admin- und Developer-Commands');
    expect(aiTriggers).not.toContain('Slash-Commands für User/Admin');
    expect(aiTriggers).toContain('globale Bot-Admin-/DEV-Verwaltung im Dashboard');
  });

  it('kennt aktuelle Discord-Funktionsgruppen', () => {
    for (const cmd of [
      '/help', '/feedback', '/erinnerung setzen', '/fraktionen', '/balance',
      '/slot', '/whitelist', '/server-ban', '/perm-add', '/upload', '/mypackages list',
    ]) {
      expect(aiCatalog).toContain(`name: '${cmd}'`);
    }
  });

  it('dokumentiert nur reale oder zentral kanonisch umbenannte Slash-Basisnamen', () => {
    const source = walkTs(path.resolve(process.cwd(), 'src/commands'))
      .map((file) => fs.readFileSync(file, 'utf8'))
      .join('\n');
    const rawDefined = [...source.matchAll(/\.setName\(\s*['"]([a-z0-9-]+)['"]\s*\)/g)].map((m) => m[1]);
    const defined = new Set(rawDefined.map((name) => CANONICAL_COMMAND_RENAMES[name] ?? name));
    const documented = [...aiCatalog.matchAll(/name:\s*['"]\/([a-z0-9-]+)/g)].map((m) => m[1]);
    const missing = [...new Set(documented.filter((name) => !defined.has(name)))];

    expect(handler).toContain("whitelist: 'whitelist-antrag'");
    expect(handler).toContain("'wl-add': 'whitelist-add'");
    expect(handler).toContain("'wl-remove': 'whitelist-remove'");
    expect(handler).toContain("'wl-list': 'whitelist'");
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
    expect(botInfo).toContain('getrennte Bot-Admin- und DEV-Bereiche');
    expect(botInfo).toContain('Hersteller');
  });

  it('/help erklaert die aktuelle sichtbare Command-Trennung und nutzt Detailseiten', () => {
    expect(help).toContain('V-Bot Prime · Command-Katalog');
    expect(help).toContain('DEV-Funktionen und `/ai` werden hier bewusst nicht angezeigt');
    expect(help).toContain("id: 'manufacturer'");
    expect(help).toContain('Hersteller-Commands duerfen im Katalog auffindbar sein');
    expect(help).toContain('function detailEmbed(');
    expect(help).toContain('function commandSelect(');
    expect(help).toContain(".setCustomId('help_prev')");
    expect(help).toContain(".setCustomId('help_next')");
    expect(help).toContain(".setCustomId('help_home')");
    expect(help).toContain('syntaxLines(entry.name, options)');
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

  it('haelt Monitoring-Doku und Alert-Labels synchron mit der Runtime', () => {
    expect(monitoring).toContain('METRICS_ENABLED=true');
    expect(monitoring).toContain('METRICS_TOKEN');
    expect(monitoring).not.toContain('METRICS_BEARER_TOKEN');
    expect(monitoring).toContain('`model`, `action`');
    expect(alerts).toContain('by (le, model, action)');
    expect(alerts).not.toContain('by (le, op)');
  });

  it('dokumentiert nur existierende npm-Skripte im Contributor-Workflow', () => {
    expect(contributing).toContain('npm run ui:dev');
    expect(contributing).toContain('npm run test:ci');
    expect(contributing).toContain('npm run test:handles');
    expect(contributing).not.toContain('npm run dev:dashboard');
    for (const script of ['ui:dev', 'test:ci', 'test:handles', 'lint:all', 'build']) {
      expect(packageJson.scripts?.[script]).toBeTruthy();
    }
    expect(packageJson.description).toContain('V-Bot Prime');
    expect(packageJson.description).toContain('Bot-Admin-/DEV-Dashboard');
  });
});
