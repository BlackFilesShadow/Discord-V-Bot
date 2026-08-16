import fs from 'node:fs';
import path from 'node:path';

const help = fs.readFileSync(path.join(process.cwd(), 'src', 'commands', 'user', 'help.ts'), 'utf8');

describe('/help welcome and navigation', () => {
  it('zeigt auf der Startseite keine Command-Wand', () => {
    const start = help.indexOf('function overviewEmbed');
    const end = help.indexOf('function optionToken', start);
    const overview = help.slice(start, end);
    expect(overview).toContain('Willkommen bei V-Bot Prime');
    expect(overview).not.toContain('embed.addFields');
    expect(overview).not.toContain('.map(entry =>');
    expect(overview).not.toContain('sichtbare Funktionen');
  });

  it('erklaert die Links/Rechts-Navigation und den Katalog-Button direkt', () => {
    expect(help).toContain('▶️ Weiter');
    expect(help).toContain('◀️ Zurueck');
    expect(help).toContain('📚 Katalog');
    expect(help).toContain(".setCustomId('help_prev')");
    expect(help).toContain(".setCustomId('help_next')");
    expect(help).toContain(".setCustomId('help_home')");
  });
});
