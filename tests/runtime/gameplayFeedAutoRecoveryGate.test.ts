import fs from 'node:fs';
import path from 'node:path';

function source(relative: string): string {
  return fs.readFileSync(path.join(process.cwd(), relative), 'utf8');
}

describe('Gameplay-Feed Nitrado self-healing architecture', () => {
  it('persistiert systembedingte Pausen separat von manueller Deaktivierung', () => {
    const schema = source('prisma/gameplay-feeds.prisma');
    const migration = source('prisma/migrations/20260919001000_gameplay_feed_auto_recovery/migration.sql');

    expect(schema).toContain('autoPausedReason          String?');
    expect(schema).toContain('autoPausedAt              DateTime?');
    expect(migration).toContain("\"autoPausedReason\" = 'NITRADO_INACTIVE'");
    expect(migration).toContain("AND \"lastErrorMsg\" = 'Automatisch deaktiviert: Nitrado-Verbindung nicht aktiv/gebunden'");
    expect(migration).toContain('AND "isActive" = TRUE');
    expect(migration).toContain('AFTER UPDATE OF "status", "nitradoServerId"');
  });

  it('reaktiviert erst nach gesunder und vollstaendig aufgeholter ADM-Quelle', () => {
    const liveSync = source('src/modules/nitrado/adm/admLiveSyncCron.ts');

    expect(liveSync).toContain('let sourceCaughtUp = candidates.length <= MAX_FILES_PER_TICK;');
    expect(liveSync).toContain('sourceCaughtUp = false;');
    expect(liveSync).toContain('if (!firstFileError && sourceCaughtUp) await resumeFeedsAfterHealthySync(conn);');
    expect(liveSync).toContain('if (baselineComplete) await resumeFeedsAfterHealthySync(conn);');
  });

  it('setzt vor Wiederaufnahme einen aktuellen Feed-High-Watermark und nutzt CAS', () => {
    const recovery = source('src/modules/gameplayFeeds/autoPauseRecovery.ts');

    expect(recovery).toContain('autoPausedReason: NITRADO_AUTO_PAUSE_REASON');
    expect(recovery).toContain("orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]");
    expect(recovery).toContain('cursorCreatedAt: watermark.createdAt');
    expect(recovery).toContain('cursorEventId: watermark.id');
    expect(recovery).toContain('isActive: false');
    expect(recovery).toContain('isActive: true');
  });
});
