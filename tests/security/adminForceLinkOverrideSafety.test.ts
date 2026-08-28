import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('Admin ForceLink/ForceUnlink override safety', () => {
  const migration = read('prisma/migrations/20260828214500_admin_force_link_virtual_archive_channel/migration.sql');
  const service = read('src/modules/linking/adminForceLink.ts');
  const command = read('src/commands/dashboard/privileged.ts');
  const cron = read('src/modules/nitrado/adm/admPostProcessCron.ts');

  it('allows the admin command to bypass missing ADM/session evidence without inventing a GUID', () => {
    expect(command).toContain('forceAdminLinkByPlayerName');
    expect(command).toContain('normale ADM-/Session-Anwesenheits- und Spielzeitregel umgangen');
    expect(service).toContain('gameId: identity?.gameId ?? null');
    expect(service).toContain('pendingIdentityResolution: !hash');
    expect(service).not.toContain("identityHash(args.playerName");
    expect(service).not.toContain("identityHash(playerName");
  });

  it('persists only the provisional exact player name until a real session resolves the GUID', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "forcedPlayerName" VARCHAR(64)');
    expect(migration).toContain('GameIdentityLink_forced_player_name_printable');
    expect(migration).toContain('GameIdentityLink_scope_forced_player_name_verified_key');
    expect(service).toContain('resolvePlayerIdentityByName');
    expect(service).toContain('reconcileAdminForcedLinks');
    expect(cron).toContain('reconcileAdminForcedLinks');
  });

  it('keeps identity ownership, leave cleanup and race fences active for admin overrides', () => {
    expect(service).toContain('assertNoOpenLeaveCleanupRequest');
    expect(service).toContain('pg_advisory_xact_lock');
    expect(service).toContain('LeaveCleanupPendingError');
    expect(service).toContain("reason: 'PLAYER_NAME_TAKEN'");
    expect(service).toContain("reason: 'IDENTITY_TAKEN'");
    expect(service).toContain("reason: 'USER_ALREADY_LINKED'");
  });

  it('ForceUnlink has no session prerequisite and clears provisional names as well', () => {
    expect(command).toContain('forceAdminUnlinkUser');
    expect(command).toContain('ADM-/Session-Erkennung ist fuer diese Admin-Aktion nicht erforderlich');
    expect(service).toContain('forceAdminUnlinkUser');
    expect(service).toContain('SET "forcedPlayerName"=NULL');
  });
});
