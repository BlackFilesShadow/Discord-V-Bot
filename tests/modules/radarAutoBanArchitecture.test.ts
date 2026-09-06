import fs from 'node:fs';
import path from 'node:path';

function read(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
}

describe('Radar Auto-Ban Architektur-Invarianten', () => {
  const runtime = read('src/modules/radar/autoBanRuntime.ts');
  const fence = read('src/modules/radar/banFence.ts');
  const migration = read('prisma/migrations/20260906003000_radar_safe_auto_ban/migration.sql');
  const route = read('src/dashboard/routes/v2/radar.ts');
  const editor = read('dashboard-ui/src/components/radar/ZoneEditor.tsx');
  const jobWorker = read('src/modules/nitrado/jobWorker.ts');
  const rebind = read('src/modules/nitrado/rebindOutboxLifecycle.ts');
  const reconcile = read('src/modules/bans/banReconciliation.ts');
  const manualBan = read('src/commands/dashboard/serverBan.ts');
  const banOutbox = read('src/modules/bans/banOutbox.ts');

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

  it('schreibt den unveränderlichen Server-Generation-Fence vor dem Ban-Outbox-Enqueue', () => {
    expect(migration).toContain('CREATE TABLE "RadarAutoBanBanFence"');
    const fenceWrite = runtime.indexOf('await upsertRadarAutoBanFence(tx,');
    const enqueue = runtime.indexOf('const queued = await enqueueServerBanAdd(', fenceWrite);
    expect(fenceWrite).toBeGreaterThanOrEqual(0);
    expect(enqueue).toBeGreaterThan(fenceWrite);
    expect(fence).toContain('RADAR_FENCE_SERVICE_MISMATCH');
    expect(fence).toContain('RADAR_FENCE_BINDING_VERSION_MISMATCH');
    expect(fence).toContain('Remote-Ban wird fail-closed verweigert');
  });

  it('prüft den Radar-Fence unmittelbar vor jedem Nitrado SERVER_BAN_ADD', () => {
    const banCase = jobWorker.indexOf("case 'SERVER_BAN_ADD':");
    const inspect = jobWorker.indexOf('inspectRadarAutoBanFenceForRemoteAdd(', banCase);
    const remoteAdd = jobWorker.indexOf('await client.addToBanlist(', banCase);
    expect(banCase).toBeGreaterThanOrEqual(0);
    expect(inspect).toBeGreaterThan(banCase);
    expect(remoteAdd).toBeGreaterThan(inspect);
    expect(jobWorker).toContain('RADAR_AUTO_BAN_REMOTE_ADD_SKIPPED');
  });

  it('disarmt Auto-Ban bei Service-Rebind und überträgt nur manuelle, niemals Radar-fenced ADD-Intents', () => {
    expect(rebind).toContain('await lockRadarScope(tx, scope.guildId, scope.nitradoConnId);');
    expect(rebind).toContain('autoBanEnabled: false');
    expect(rebind).toContain("autoBanLastError: 'AUTOBAN_SERVICE_REBIND'");
    expect(rebind).toContain('invalidatedAt: now');
    expect(rebind).toContain('active: false');
    expect(rebind).toContain("operation: 'SERVER_BAN_ADD'");
    expect(rebind).toContain('radarBanSet.has(banId)');
    expect(rebind).toContain('Radar auto-ban superseded by Nitrado service rebind before remote execution');
    expect(rebind).toContain("'WHITELIST_ADD',\n  'WHITELIST_REMOVE',\n  'SERVER_BAN_REMOVE'");
  });

  it('verbietet auch dem automatischen Ban-Reconciler jede generation-fremde Radar-Reparatur', () => {
    const loop = reconcile.indexOf('for (const ban of local)');
    const inspect = reconcile.indexOf('inspectRadarAutoBanFenceForRemoteAdd(', loop);
    const enqueue = reconcile.indexOf('await enqueueServerBanAdd(', loop);
    expect(inspect).toBeGreaterThan(loop);
    expect(enqueue).toBeGreaterThan(inspect);
    expect(reconcile).toContain('RADAR_AUTO_BAN_RECONCILE_SKIPPED');
  });

  it('macht explizite manuelle Moderation zum bewussten Override und entfernt den Radar-Fence unter demselben Scope-Lock', () => {
    const tx = manualBan.indexOf('const stored = await prisma.$transaction(async tx => {');
    const lock = manualBan.indexOf('await lockRadarScope(tx, scope.guildId, target.id);', tx);
    const clear = manualBan.indexOf('await clearRadarAutoBanFence(tx, banScope, row.id);', lock);
    const enqueue = manualBan.indexOf('const queued = await enqueueServerBanAdd(', clear);
    expect(lock).toBeGreaterThan(tx);
    expect(clear).toBeGreaterThan(lock);
    expect(enqueue).toBeGreaterThan(clear);
  });

  it('kennzeichnet Radar-Outbox-Intents zusätzlich, ohne den Fence als Autorität zu ersetzen', () => {
    expect(banOutbox).toContain('radarAutoBan?: true');
    expect(banOutbox).toContain('hasActiveRadarFence');
    expect(banOutbox).toContain('invalidatedAt: null');
    expect(banOutbox).toContain('radarAutoBan: true as const');
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
