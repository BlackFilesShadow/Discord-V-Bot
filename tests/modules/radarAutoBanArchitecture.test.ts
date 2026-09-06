import fs from 'node:fs';
import path from 'node:path';

function read(relative: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
}

describe('Radar Auto-Ban Architektur-Invarianten', () => {
  const autoBanRuntime = read('src/modules/radar/autoBanRuntime.ts');
  const radarRuntime = read('src/modules/radar/runtime.ts');
  const catalog = read('src/modules/radar/catalog.ts');
  const evidence = read('src/modules/radar/evidence.ts');
  const coordinates = read('src/shared/radarCoordinates.ts');
  const fence = read('src/modules/radar/banFence.ts');
  const autoBanMigration = read('prisma/migrations/20260906003000_radar_safe_auto_ban/migration.sql');
  const precisionMigration = read('prisma/migrations/20260906213000_radar_precision_policy/migration.sql');
  const route = read('src/dashboard/routes/v2/radar.ts');
  const editor = read('dashboard-ui/src/components/radar/ZoneEditor.tsx');
  const map = read('dashboard-ui/src/components/radar/DayzRadarMap.tsx');
  const jobWorker = read('src/modules/nitrado/jobWorker.ts');
  const rebind = read('src/modules/nitrado/rebindOutboxLifecycle.ts');
  const reconcile = read('src/modules/bans/banReconciliation.ts');
  const manualBan = read('src/commands/dashboard/serverBan.ts');
  const banOutbox = read('src/modules/bans/banOutbox.ts');

  it('erhaelt die bewaehrten Zeit-/Snapshot-Sicherungen und rearmt die neue Policy an der Migrationsgrenze', () => {
    expect(autoBanMigration).toContain('ADD COLUMN "autoBanEnabled" BOOLEAN NOT NULL DEFAULT FALSE');
    expect(precisionMigration).toContain('RADAR_PRECISION_POLICY_MIGRATION_REARMED');
    expect((precisionMigration.match(/WHERE z\."autoBanEnabled" = TRUE/g) ?? [])).toHaveLength(2);
    expect(precisionMigration).toContain('"version" = z."version" + 1');
    expect(precisionMigration).toContain('"updatedAt" = CURRENT_TIMESTAMP');
    expect(precisionMigration).toContain('adm_created_at <= z."updatedAt" OR adm_occurred_at <= z."updatedAt"');
    expect(precisionMigration).toContain('ADM_EVENT_PREDATES_AUTOBAN_ARM');
  });

  it('macht ausschliesslich BAN_* Funktionen punitiv und laesst Spieler-Erkennung garantiert nicht bannen', () => {
    expect(catalog).toContain("key: 'PLAYER_DETECTION'");
    expect(catalog).toContain('punitive: false');
    expect(catalog).toContain("key: 'BAN_PLAYER_DETECTION'");
    expect(catalog).toContain("key: 'BAN_EXPLOSION'");
    expect(precisionMigration).toContain("IF left(NEW.\"functionKey\", 4) <> 'BAN_' THEN");
    expect(precisionMigration).toContain("NEW.\"autoBanStatus\" := 'DISABLED'");
    expect(autoBanRuntime).toContain("if (!definition || !definition.punitive)");
  });

  it('leitet Auto-Ban im API ausschliesslich aus den Funktions-Toggles ab und besitzt keinen Dashboard-Hauptschalter', () => {
    expect(route).toContain('autoBanEnabled: radarHasPunitiveFunction(body.enabledFunctions)');
    expect(route).not.toContain('body.autoBanEnabled');
    expect(editor).not.toContain('Automatischer Server-Ban');
    expect(editor).not.toContain('autoBanEnabled');
    expect(editor).toContain('Es gibt keinen zusätzlichen Auto-Ban-Hauptschalter');
  });

  it('entfernt die konfigurierbare Hoehenbegrenzung aus dem Dashboard und behaelt Hoehe nur als exakte ADM-Evidenz', () => {
    expect(route).not.toContain('body.altitudeEnabled');
    expect(route).toContain('altitudeEnabled: false');
    expect(editor).not.toContain('ADM-Höhenfilter');
    expect(editor).not.toContain('Minimale ADM-Höhe');
    expect(radarRuntime).toContain('altitude: candidate.position.altitude');
    expect(autoBanRuntime).toContain('candidate.position.altitude');
    expect(autoBanRuntime).toContain('POSITION_EPSILON_METERS');
    expect(precisionMigration).toContain('"altitudeEnabled" = FALSE');
  });

  it('verwendet nach aussen ausschliesslich X/Z und erzeugt fuer die gespeicherte Ereignisposition einen iZurvive-Link', () => {
    expect(radarRuntime).toContain("const z = Number(event.y).toFixed(1);");
    expect(radarRuntime).toContain('`X: ${x} · Z: ${z}`');
    expect(radarRuntime).toContain('dayzIzurviveUrl(map, { x: Number(event.x), y: Number(event.y) })');
    expect(radarRuntime).not.toContain('ADM-Hoehe');
    expect(editor).toContain('Geometrie X/Z');
    expect(editor).toContain('Mittelpunkt Z');
  });

  it('normalisiert TerritoryFlag bewusst als X/Hoehe/Z und bannt den ausfuehrenden Actor an der Flaggenposition', () => {
    expect(coordinates).toContain('export function parseAdmTerritoryFlagPosition');
    expect(coordinates).toContain('y: values[2], altitude: values[1]');
    expect(catalog).toContain("targetName !== 'TerritoryFlag'");
    expect(catalog).toContain('parseAdmTerritoryFlagPosition(event.targetPosition)');
  });

  it('ordnet Hit/Kill dem Target-Angreifer zu und trennt Explosion fail-closed von normalen Hit/Kill-Regeln', () => {
    expect(catalog).toMatch(
      /return candidate\(\s*'TARGET',\s*event\.targetGameId,\s*event\.targetName,\s*parseAdmDayzPosition\(event\.targetPosition\)/s,
    );
    expect(catalog).toContain('event.targetGameId === event.actorGameId');
    expect(catalog).toContain('isExplosiveRadarEvent(event) ? [] : attackingPlayerPosition(event)');
    expect(catalog).toContain('isExplosiveRadarEvent(event) ? attackingPlayerPosition(event) : []');
    expect(catalog).toContain('if (!event.targetGameId');
  });

  it('loest Disconnect nur ueber frische, gleiche Session/Binding-Positions-Evidenz und niemals ueber Schaetzung', () => {
    expect(evidence).toContain('DISCONNECT_POSITION_MAX_AGE_MS = 6 * 60_000');
    expect(evidence).toContain("eventType: 'PLAYER_CONNECTED'");
    expect(evidence).toContain("eventType: 'PLAYER_POSITION'");
    expect(evidence).toContain('sourceBelongsToBinding');
    expect(evidence).toContain('occurredAt: { gt: sessionFloor, lte: event.occurredAt }');
    expect(evidence).toContain('return []');
    expect(autoBanRuntime).toContain('await resolveRadarCandidates(tx, definition, admEvent');
  });

  it('interpretiert Radar-Ereignisse nie gegen eine spaetere Zone und verlangt auch frische Positions-Evidenz', () => {
    expect(radarRuntime).toContain('eventBelongsToCurrentZoneGeneration');
    expect(radarRuntime).toContain('event.occurredAt.getTime() > generationStartedAt');
    expect(radarRuntime).toContain('event.createdAt.getTime() > generationStartedAt');
    expect(radarRuntime).toContain('candidate.evidenceOccurredAt.getTime() > generationStartedAt');
  });

  it('bindet jede punitive Entscheidung an Version, Funktion, Allowlist, Binding und 10m horizontalen Sicherheitsrand', () => {
    for (const invariant of [
      'FUNCTION_NOT_PUNITIVE',
      'ZONE_VERSION_CHANGED',
      'AUTOBAN_ARM_GENERATION_CHANGED',
      'AUTOBAN_AUTHORIZER_CHANGED',
      'FUNCTION_DISABLED_CURRENTLY',
      'ACTOR_ALLOWLISTED',
      'BOUNDARY_SAFETY_MARGIN',
      'ADM_EVENT_PREDATES_ZONE_GENERATION',
      'ADM_EVENT_TYPE_CHANGED',
      'ADM_BINDING_GENERATION_MISMATCH',
      'EVENT_POSITION_OR_FUNCTION_MISMATCH',
      'ADM_TIME_IN_FUTURE',
      'POSITION_OUTSIDE_MAP',
    ]) {
      expect(autoBanRuntime).toContain(invariant);
    }
    expect(autoBanRuntime).toContain('containsPositionWithMargin');
    expect(autoBanRuntime).toContain('AUTO_BAN_SAFETY_MARGIN_METERS = 10');
  });

  it('vermeidet doppelte Spieler-Meldungen wenn Spieler-Erkennung und Bann-Erkennung gemeinsam aktiv sind', () => {
    expect(radarRuntime).toContain("definition.key === 'PLAYER_DETECTION'");
    expect(radarRuntime).toContain("entry.functionKey === 'BAN_PLAYER_DETECTION'");
  });

  it('liefert den HD-Hybrid source-faithful statt kuenstlich hochskalierter Kartendetails', () => {
    expect(map).toContain("url: `/radar/maps/${activeMap.toLowerCase()}.png`");
    expect(map).toContain("'raster-resampling': 'nearest'");
    expect(map).toContain("'raster-resampling': 'linear'");
    expect(map).toContain("map.addSource('coordinate-grid'");
    expect(map).toContain('gridSpacingForZoom');
    expect(map).toContain('X ${point.x.toFixed(1)} · Z ${point.y.toFixed(1)}');
  });

  it('schreibt den unveraenderlichen Server-Generation-Fence vor dem Ban-Outbox-Enqueue', () => {
    expect(autoBanMigration).toContain('CREATE TABLE "RadarAutoBanBanFence"');
    const fenceWrite = autoBanRuntime.indexOf('await upsertRadarAutoBanFence(tx,');
    const enqueue = autoBanRuntime.indexOf('const queued = await enqueueServerBanAdd(', fenceWrite);
    expect(fenceWrite).toBeGreaterThanOrEqual(0);
    expect(enqueue).toBeGreaterThan(fenceWrite);
    expect(fence).toContain('RADAR_FENCE_SERVICE_MISMATCH');
    expect(fence).toContain('RADAR_FENCE_BINDING_VERSION_MISMATCH');
  });

  it('prueft den Radar-Fence unmittelbar vor jedem Nitrado SERVER_BAN_ADD', () => {
    const banCase = jobWorker.indexOf("case 'SERVER_BAN_ADD':");
    const inspect = jobWorker.indexOf('inspectRadarAutoBanFenceForRemoteAdd(', banCase);
    const remoteAdd = jobWorker.indexOf('await client.addToBanlist(', banCase);
    expect(banCase).toBeGreaterThanOrEqual(0);
    expect(inspect).toBeGreaterThan(banCase);
    expect(remoteAdd).toBeGreaterThan(inspect);
    expect(jobWorker).toContain('RADAR_AUTO_BAN_REMOTE_ADD_SKIPPED');
  });

  it('disarmt Auto-Ban bei Service-Rebind und uebertraegt niemals generation-fremde Radar-fenced ADD-Intents', () => {
    expect(rebind).toContain('await lockRadarScope(tx, scope.guildId, scope.nitradoConnId);');
    expect(rebind).toContain('autoBanEnabled: false');
    expect(rebind).toContain("autoBanLastError: 'AUTOBAN_SERVICE_REBIND'");
    expect(rebind).toContain('invalidatedAt: now');
    expect(rebind).toContain('radarBanSet.has(banId)');
  });

  it('verbietet auch dem automatischen Ban-Reconciler generation-fremde Radar-Reparatur', () => {
    const loop = reconcile.indexOf('for (const ban of local)');
    const inspect = reconcile.indexOf('inspectRadarAutoBanFenceForRemoteAdd(', loop);
    const enqueue = reconcile.indexOf('await enqueueServerBanAdd(', loop);
    expect(inspect).toBeGreaterThan(loop);
    expect(enqueue).toBeGreaterThan(inspect);
    expect(reconcile).toContain('RADAR_AUTO_BAN_RECONCILE_SKIPPED');
  });

  it('macht manuelle Moderation zum bewussten Override und entfernt den Radar-Fence unter demselben Scope-Lock', () => {
    const tx = manualBan.indexOf('const stored = await prisma.$transaction(async tx => {');
    const lock = manualBan.indexOf('await lockRadarScope(tx, scope.guildId, target.id);', tx);
    const clear = manualBan.indexOf('await clearRadarAutoBanFence(tx, banScope, row.id);', lock);
    const enqueue = manualBan.indexOf('const queued = await enqueueServerBanAdd(', clear);
    expect(lock).toBeGreaterThan(tx);
    expect(clear).toBeGreaterThan(lock);
    expect(enqueue).toBeGreaterThan(clear);
  });

  it('verwendet ausschliesslich den bestehenden gescoppten Ban-Registry/Outbox-Pfad', () => {
    expect(autoBanRuntime).toContain("import { addBan, isBanActive, type BanClient } from '../bans/banRegistry';");
    expect(autoBanRuntime).toContain("import { enqueueServerBanAdd, type BanOutboxClient } from '../bans/banOutbox';");
    expect(autoBanRuntime).toContain('hashBanIdentifier');
    expect(autoBanRuntime).not.toContain('client.addBan');
    expect(banOutbox).toContain('radarAutoBan?: true');
  });
});
