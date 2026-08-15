import fs from 'node:fs';
import path from 'node:path';

const help = fs.readFileSync(path.join(process.cwd(), 'src', 'commands', 'user', 'help.ts'), 'utf8');
const publicAiCatalog = fs.readFileSync(path.join(process.cwd(), 'src', 'modules', 'ai', 'commandCatalog.ts'), 'utf8');

describe('production public command surfaces', () => {
  it('ordnet /help in der vereinbarten Reihenfolge Moderation -> Nitrado -> Economy -> Hersteller', () => {
    const moderation = help.indexOf("id: 'moderation'");
    const nitrado = help.indexOf("id: 'nitrado'");
    const economy = help.indexOf("id: 'economy'");
    const manufacturer = help.indexOf("id: 'manufacturer'");

    expect(moderation).toBeGreaterThan(-1);
    expect(nitrado).toBeGreaterThan(moderation);
    expect(economy).toBeGreaterThan(nitrado);
    expect(manufacturer).toBeGreaterThan(economy);
  });

  it('verwendet in /help ausschliesslich die kanonischen Whitelist-Namen', () => {
    expect(help).toContain("'whitelist-antrag'");
    expect(help).toContain("'whitelist-add'");
    expect(help).toContain("'whitelist-remove'");
    expect(help).toContain("'whitelist'");
    expect(help).not.toContain("'wl-add'");
    expect(help).not.toContain("'wl-remove'");
    expect(help).not.toContain("'wl-list'");
  });

  it('macht DEV und /ai in der sichtbaren Hilfe explizit unsichtbar', () => {
    expect(help).toContain('DEV-Funktionen und `/ai` werden hier bewusst nicht angezeigt');
    expect(help).toContain('visibleCommandCatalog');
    expect(help).not.toContain("names: new Set(['ai'");
  });

  it('enthaelt /ai und die Legacy-Whitelist-Namen nicht mehr im oeffentlichen AI-Command-Katalog', () => {
    expect(publicAiCatalog).not.toMatch(/name:\s*['"]\/ai(?:\s|['"])/);
    expect(publicAiCatalog).not.toContain("name: '/wl-add'");
    expect(publicAiCatalog).not.toContain("name: '/wl-remove'");
    expect(publicAiCatalog).not.toContain("name: '/wl-list'");
    expect(publicAiCatalog).toContain("name: '/whitelist-antrag'");
    expect(publicAiCatalog).toContain("name: '/whitelist-add'");
    expect(publicAiCatalog).toContain("name: '/whitelist-remove'");
  });
});
