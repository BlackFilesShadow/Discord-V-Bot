import fs from 'node:fs';
import path from 'node:path';

describe('Whitelist-Info-Embed', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/modules/whitelist/whitelistChannels.ts'),
    'utf8',
  );

  it('beschreibt den produktiven Whitelist-Antrag mit dem kanonischen Command', () => {
    expect(source).toContain("statusTitle('INFO', 'Whitelist-Antrag')");
    expect(source).toContain('`/whitelist-antrag`');
    expect(source).toContain('bei `id` deinen **exakten Spielernamen**');
    expect(source).toContain('bei `slot` den gewünschten Server über seinen Alias');
    expect(source).toContain('Bei nur einem aktiven Server ist keine Serverauswahl nötig.');
  });

  it('enthaelt die veraltete Whitelist-Command-Syntax nicht mehr', () => {
    expect(source).not.toContain('/whitelist id:');
    expect(source).not.toContain("statusTitle('INFO', 'Whitelist-System')");
  });
});
