import fs from 'node:fs';
import path from 'node:path';

function read(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
}

describe('Radar Auto-Ban Architektur-Invarianten', () => {
  const runtime = read('src/modules/radar/autoBanRuntime.ts');
  const migration = read('prisma/migrations/20260906003000_radar_safe_auto_ban/migration.sql');
  const route = read('src/dashboard/routes/v2/radar.ts');
  const editor = read('dashboard-ui/src/components/radar/ZoneEditor.tsx');

  it('ist opt-in und schließt alte oder verspätet ingestierte ADM-Ereignisse schon beim Snapshot aus', () => {
    expect(migration).toContain('ADD COLUMN "autoBanEnabled" BOOLEAN NOT NULL DEFAULT FALSE');
    expect(migration).toContain('adm_created_at <= z."autoBanEnabledAt" OR adm_occurred_at <= z."autoBanEnabledAt"');
    expect(migration).toContain("NEW.\"autoBanStatus\" := 'SKIPPED'");
    expect(migration).toContain('ADM_EVENT_PREDATES_AUTOBAN_ARM');
  });

  it('bindet jede punitive Entscheidung an Version, Funktion, Allowlist, Binding und Sicherheitsrand', () => {
    for (const invariant of [
      'ZONE_VERSION_CHANGED',
      'AUTOBAN_ARM_GENERATION_CHANGED',
      'AUTOBAN_AUTHORIZER_CHANGED',
      'FUNCTION_DISABLED_CURRENTLY',
      'ACTOR_ALLOWLISTED',
      'BOUNDARY_SAFETY_MARGIN',
      'ADM_EVENT_TYPE_CHANGED',
      'ADM_ACTOR_GUID_MISMATCH',
      'ADM_BINDING_GENERATION_MISMATCH',
      'EVENT_POSITION_OR_FUNCTION_MISMATCH',
      'ADM_TIME_IN_FUTURE',
    ]) {
      expect(runtime).toContain(invariant);
    }
    expect(runtime).toContain('containsPositionWithMargin');
    expect(runtime).toContain('AUTO_BAN_SAFETY_MARGIN_METERS = 10');
  });

  it('verwendet ausschließlich den bestehenden gescoppten Ban-Registry/Outbox-Pfad', () => {
    expect(runtime).toContain("import { addBan, isBanActive, type BanClient } from '../bans/banRegistry';");
    expect(runtime).toContain("import { enqueueServerBanAdd, type BanOutboxClient } from '../bans/banOutbox';");
    expect(runtime).toContain('hashBanIdentifier');
    expect(runtime).toContain('guildId: event.guildId, nitradoConnId: event.nitradoConnId');
    expect(runtime).not.toContain('.addBan(');
    expect(runtime).not.toContain('client.addBan');
  });

  it('serialisiert Zonenänderungen gegen den Ban-Commit und zeigt Auto-Ban explizit als separaten Toggle', () => {
    expect(route).toContain('await lockRadarScope(tx, scope.guildId, scope.connId);');
    expect(route).toContain('autoBanAuthorizedBy');
    expect(editor).toContain('label="Automatischer Server-Ban"');
    expect(editor).toContain('10-m-Sicherheitsrands');
    expect(editor).toContain('autoBanEnabled: false');
  });
});
