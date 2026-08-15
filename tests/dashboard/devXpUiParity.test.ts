import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(process.cwd(), 'dashboard-ui/src/pages/dev/CommandCenter.tsx'),
  'utf8',
);

describe('DEV XP UI parity', () => {
  it('laedt persistierte XP-Werte statt mit leeren destruktiven Feldern zu starten', () => {
    expect(source).toContain('useEffect(() => {');
    expect(source).toContain('setMin(String(cfg.messageXpMin))');
    expect(source).toContain('setMaxRole(cfg.maxLevelRoleId ??');
    expect(source).toContain('setAllowedRoles(Array.isArray(cfg.allowedRoleIds)');
    expect(source).toContain('setAllowedChannels(Array.isArray(cfg.allowedChannelIds)');
  });

  it('verwendet echte Guild-Rollen und -Channels statt kommaseparierter Roh-IDs', () => {
    expect(source).toContain('xp.data?.roleOptions');
    expect(source).toContain('xp.data?.channelOptions');
    expect(source).toContain('type="checkbox" checked={allowedRoles.includes(role.id)}');
    expect(source).toContain('type="checkbox" checked={allowedChannels.includes(channel.id)}');
    expect(source).not.toContain('Allowed Role IDs, kommasepariert');
    expect(source).not.toContain('Allowed Channel IDs, kommasepariert');
  });

  it('macht das Leeren optionaler Filter explizit', () => {
    expect(source).toContain("clearMaxLevelRoleId: maxRole === ''");
    expect(source).toContain('clearAllowedRoleIds: allowedRoles.length === 0');
    expect(source).toContain('clearAllowedChannelIds: allowedChannels.length === 0');
  });
});
