import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

describe('Dashboard-1V deleted Discord role cleanup', () => {
  test('GuildRoleDelete removes only the exact Guild+Role permission grant best-effort', () => {
    const source = read('src/events/guildRoleDelete.ts');
    expect(source).toContain('name: Events.GuildRoleDelete');
    expect(source).toContain('prisma.guildPermissionRoleGrant.deleteMany');
    expect(source).toContain('guildId: deletedRole.guild.id');
    expect(source).toContain('roleDiscordId: deletedRole.id');
    expect(source).toContain('catch (error)');
    expect(source).toContain('PERM_ROLE_GRANT_REMOVED_ON_ROLE_DELETE');
  });

  test('role-delete cleanup event is registered exactly once in the production event array', () => {
    const source = read('src/index.ts');
    expect(source).toContain("import guildRoleDeleteEvent from './events/guildRoleDelete';");
    const occurrences = source.match(/\bguildRoleDeleteEvent\b/g) ?? [];
    expect(occurrences).toHaveLength(2); // import + one events[] entry
  });
});
