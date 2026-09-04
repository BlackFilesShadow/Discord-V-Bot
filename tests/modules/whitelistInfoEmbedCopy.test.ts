import fs from 'node:fs';
import path from 'node:path';

describe('Whitelist-Info-Embed', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../src/modules/whitelist/whitelistChannels.ts'),
    'utf8',
  );

  it('erklaert Whitelist und verweist auf den produktiven Antrag-Command ohne technische Slot-/ID-Sprache', () => {
    expect(source).toContain("vEmbed(Colors.Info)");
    expect(source).toContain(".setTitle('Whitelist')");
    expect(source).toContain('`/whitelist-antrag`');
    expect(source).toContain('Trage deinen **exakten Spielernamen** ein');
    expect(source).toContain('wähle den gewünschten Server über seinen Alias aus');
    expect(source).toContain('Bei nur einem aktiven Server ist keine Serverauswahl nötig.');
    expect(source).not.toContain('bei `slot` den gewünschten Server');
    expect(source).not.toContain('Request-ID: ${args.requestId}');
  });

  it('enthaelt keine veraltete oder falsche Member-Antrag-Syntax', () => {
    expect(source).not.toContain('/whitelist id:');
    expect(source).not.toContain('1. Nutze `/whitelist` in diesem Kanal.');
    expect(source).not.toContain("statusTitle('INFO', 'Whitelist-System')");
  });
});
