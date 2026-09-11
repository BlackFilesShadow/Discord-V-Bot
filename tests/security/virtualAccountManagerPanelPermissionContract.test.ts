import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/modules/economy/virtualAccountManagerPanelSafety.ts'),
  'utf8',
);

describe('virtual account manager-panel Discord permission contract', () => {
  test('preflight requires the permission Discord uses for channel overwrites', () => {
    const start = source.indexOf('async function requirePanelPermissions');
    const end = source.indexOf('async function restoreAccessStrict', start);
    const preflight = source.slice(start, end);

    expect(preflight).toContain('PermissionFlagsBits.ManageRoles');
    expect(preflight).not.toContain('PermissionFlagsBits.ManageChannels');
    expect(preflight).toContain('Berechtigungen verwalten');
  });

  test('the protected manager workflow really writes member and everyone permission overwrites', () => {
    expect(source).toContain('channel.permissionOverwrites.edit(guild.roles.everyone.id');
    expect(source).toContain('channel.permissionOverwrites.edit(userId');
    expect(source).toContain('channel.permissionOverwrites.edit(row.userDiscordId');
  });
});
