import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/commands/dashboard/privileged.ts'), 'utf8');

describe('force-link admin command gate', () => {
  it('keeps force-link and force-unlink privileged and explicitly session-independent', () => {
    expect(source).toContain(".setName('force-link')");
    expect(source).toContain(".setName('force-unlink')");
    expect(source).toContain("requirePerm: 'economy.manage'");
    expect(source).toContain('normale ADM-/Session-Anwesenheits- und Spielzeitregel umgangen');
    expect(source).toContain('ADM-/Session-Erkennung ist fuer diese Admin-Aktion nicht erforderlich');
  });
});
