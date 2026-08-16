import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.join(process.cwd(), 'dashboard-ui', 'src', 'pages', 'Server.tsx'),
  'utf8',
);

describe('Killfeed dashboard placement', () => {
  it('entfernt den eigenstaendigen Killfeed-Haupttab', () => {
    expect(source).not.toContain("| 'killfeed'");
    expect(source).not.toContain("key: 'killfeed'");
    expect(source).not.toContain("tab === 'killfeed'");
  });

  it('rendert das bestehende Killfeed-Konstrukt ausschliesslich als Nitrado Page 2', () => {
    expect(source).toContain('1 · Server &amp; Verbindung');
    expect(source).toContain('2 · Killfeed &amp; ADM');
    expect(source).toContain('<KillfeedTab guildId={guildId} isOwner={canManageKillfeed} slots={slots} />');
    expect(source.match(/<KillfeedTab /g)?.length).toBe(1);
  });

  it('bewahrt die Killfeed-Berechtigung getrennt von der Owner-only Nitrado-Verwaltung', () => {
    expect(source).toContain("canManageKillfeed={isOwner || hasFullAccess || perms.includes('killfeed.manage')}");
    expect(source).toContain('disabled={!isOwner}');
    expect(source).toContain('disabled={!canManageKillfeed}');
  });
});
