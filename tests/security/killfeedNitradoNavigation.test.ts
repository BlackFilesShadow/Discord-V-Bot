import fs from 'node:fs';
import path from 'node:path';

const server = fs.readFileSync(
  path.join(process.cwd(), 'dashboard-ui', 'src', 'pages', 'Server.tsx'),
  'utf8',
);
const slot = fs.readFileSync(
  path.join(process.cwd(), 'dashboard-ui', 'src', 'pages', 'ServerSlot.tsx'),
  'utf8',
);

describe('Killfeed dashboard placement', () => {
  it('hat weiterhin keinen eigenstaendigen globalen Killfeed-Haupttab', () => {
    expect(server).not.toContain("| 'killfeed'");
    expect(server).not.toContain("key: 'killfeed'");
    expect(server).not.toContain('<KillfeedTab ');
  });

  it('bleibt im konkreten Gameserver-Slot auf Page 2 neben den zwei separierten Economy-Oberflaechen', () => {
    expect(slot).toContain("type Tab = 'settings' | 'whitelist' | 'economy' | 'links' | 'virtual-accounts' | 'bank-casino' | 'killfeed'");
    expect(slot).toContain('>Page 1</p>');
    expect(slot).toContain('>Page 2</p>');
    expect(slot).toContain("['virtual-accounts', 'Virtuelle Konten', Banknote]");
    expect(slot).toContain("['bank-casino', 'Bank und Casino Funktionen', Dice5]");
    expect(slot).toContain("['killfeed', 'Killfeed & ADM', Crosshair]");
    expect(slot).toContain('<KillfeedTab guildId={guildId} isOwner={true} slots={currentKillfeedSlots} />');
    expect(slot.match(/<KillfeedTab /g)?.length).toBe(1);
  });

  it('beschraenkt Killfeed weiterhin auf den aktuell sichtbaren Slot und die kanonische Killfeed-Berechtigung', () => {
    expect(slot).toContain("filter(row => String(row.slot) === slot)");
    expect(slot).toContain("permissions.includes('killfeed.manage')");
    expect(slot).toContain("permissions.includes('dashboard.access')");
    expect(slot).toContain("queryKey: ['dashboard-slot-meta', guildId, slot]");
  });
});
