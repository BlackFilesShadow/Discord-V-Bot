import fs from 'node:fs';
import path from 'node:path';
import {
  isDelegablePermissionScope,
  sanitizeDelegablePermissionScopes,
} from '../../src/modules/permissions/policy';
import { permissionMutationLockKeys } from '../../src/modules/permissions/mutationService';

const ROOT = path.resolve(__dirname, '../..');
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

describe('Dashboard-1V permission integrity architecture', () => {
  test('sanitizer keeps only known delegable scopes and removes duplicates', () => {
    expect(sanitizeDelegablePermissionScopes([
      'dashboard.view',
      'dashboard.view',
      'permissions.manage',
      'dev.console',
      'totally.unknown',
      123,
      null,
    ])).toEqual(['dashboard.view']);
    expect(isDelegablePermissionScope('dashboard.view')).toBe(true);
    expect(isDelegablePermissionScope('permissions.manage')).toBe(false);
    expect(isDelegablePermissionScope('totally.unknown')).toBe(false);
  });

  test('mutation lock is stable per target and distinct across target/kind/guild', () => {
    const a = permissionMutationLockKeys('123456789012345678', 'USER', '223456789012345678');
    expect(permissionMutationLockKeys('123456789012345678', 'USER', '223456789012345678')).toEqual(a);
    expect(permissionMutationLockKeys('123456789012345678', 'USER', '323456789012345678')).not.toEqual(a);
    expect(permissionMutationLockKeys('123456789012345678', 'ROLE', '223456789012345678')).not.toEqual(a);
    expect(permissionMutationLockKeys('923456789012345678', 'USER', '223456789012345678')).not.toEqual(a);
  });

  test('HTTP, commands and socket all use the canonical access resolver', () => {
    for (const file of [
      'src/dashboard/middleware/auth.ts',
      'src/commands/middleware/withGuildScope.ts',
      'src/dashboard/socket/guild.ts',
      'src/dashboard/routes/v2/guilds.ts',
    ]) {
      expect(read(file)).toContain('resolveGuildPermissionAccess');
    }
    expect(read('src/dashboard/middleware/auth.ts')).not.toContain('guildPermissionGrant.findUnique');
    expect(read('src/commands/middleware/withGuildScope.ts')).not.toContain('guildPermissionGrant.findUnique');
    expect(read('src/dashboard/socket/guild.ts')).not.toContain('guildPermissionGrant.findUnique');
  });

  test('dashboard and slash permission writes share the mutation engine', () => {
    const repository = read('src/modules/permissions/repository.ts');
    const command = read('src/commands/dashboard/permissions.ts');
    const engine = read('src/modules/permissions/mutationService.ts');
    expect(repository).toContain('mutatePermissionGrant');
    expect(command).toContain('mutatePermissionGrant');
    expect(engine).toContain('pg_advisory_xact_lock');
    expect(engine).toContain('targetKind: PermissionGrantTargetKind');
  });

  test('grant entry points validate current Discord targets fail-closed', () => {
    const route = read('src/dashboard/routes/v2/permissions.ts');
    const command = read('src/commands/dashboard/permissions.ts');
    expect(route).toContain('resolveDelegableUserTarget');
    expect(route).toContain('resolveDelegableRoleTarget');
    expect(command).toContain('resolveDelegableUserTarget');
  });

  test('last-scope revoke deletes both user and role rows', () => {
    const engine = read('src/modules/permissions/mutationService.ts');
    expect((engine.match(/if \(next\.length === 0\)/g) ?? []).length).toBe(2);
    expect(engine).toContain('guildPermissionGrant.delete({ where })');
    expect(engine).toContain('guildPermissionRoleGrant.delete({ where })');
  });
});
