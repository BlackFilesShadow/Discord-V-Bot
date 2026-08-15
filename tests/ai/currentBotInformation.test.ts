import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), rel), 'utf8');
}

describe('current bot information surfaces', () => {
  const aiCatalog = read('src/modules/ai/commandCatalog.ts');
  const aiHandler = read('src/modules/ai/aiHandler.ts');
  const about = read('src/commands/about.ts');
  const help = read('src/commands/user/help.ts');
  const readme = read('README.md');
  const security = read('SECURITY.md');
  const architecture = read('docs/ARCHITECTURE.md');

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

  it('leitet Hersteller-Uploadinformationen aus der echten Config ab statt alte 2GB zu behaupten', () => {
    expect(aiCatalog).toContain('config.upload.maxFileSizeBytes');
    expect(aiCatalog).toContain('config.upload.allowedExtensions');
    expect(aiCatalog).not.toMatch(/2\s*GB/i);
    expect(about).toContain('config.upload.maxFileSizeBytes');
  });

  it('stellt den Bot ohne fehlende about.md-Runtime-Abhaengigkeit vor', () => {
    expect(about).not.toContain('about.md');
    expect(about).toContain("import { BOT_DEVELOPER }");
    expect(about).toContain('/help');
    expect(about).toContain('Bot-Admin- und DEV-Werkzeuge werden im Web-Dashboard verwaltet');
  });

  it('/help erklaert die aktuelle Dashboard-Trennung', () => {
    expect(help).toContain('Aktuelle Discord-Commands');
    expect(help).toContain('Bot-Admin & DEV: Web-Dashboard');
    expect(help).toContain('Hersteller-Slash-Funktionen bleiben in Discord');
  });

  it('kanonische Doku beschreibt keinen alten globalen Admin/DEV-Slash-Betrieb mehr', () => {
    for (const doc of [readme, security, architecture]) {
      expect(doc).toContain('Dashboard');
      expect(doc).not.toMatch(/\/admin-aimodels\b/);
      expect(doc).not.toMatch(/\/dev-login\b/);
      expect(doc).not.toMatch(/\/dev-reload\b/);
    }
    expect(readme).toContain('Void_Architect');
    expect(security).toContain('verifizierten Step-Up');
    expect(architecture).toContain('ADM V2');
  });
});
