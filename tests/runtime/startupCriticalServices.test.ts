import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');

describe('production startup critical-service invariants', () => {
  it('bricht den Prozessstart ab wenn das dashboard-only Admin/DEV-System nicht starten kann', () => {
    const start = source.indexOf('dashboardRuntime = await startDashboard(client)');
    const catchStart = source.indexOf("logger.error('Dashboard konnte nicht gestartet werden; Start wird abgebrochen:'", start);
    const destroy = source.indexOf('await client.destroy();', catchStart);
    const disconnect = source.indexOf('await prisma.$disconnect().catch(() => undefined);', catchStart);
    const rethrow = source.indexOf('throw error;', catchStart);
    const complete = source.indexOf('vollständig gestartet');

    expect(start).toBeGreaterThanOrEqual(0);
    expect(catchStart).toBeGreaterThan(start);
    expect(destroy).toBeGreaterThan(catchStart);
    expect(disconnect).toBeGreaterThan(catchStart);
    expect(rethrow).toBeGreaterThan(disconnect);
    expect(complete).toBeGreaterThan(rethrow);
  });

  it('meldet partielle Guild-Deploys explizit statt sie als vollstaendig erfolgreich zu loggen', () => {
    expect(source).toContain('if (res.guildsFailed > 0)');
    expect(source).toContain('Command-Sync unvollständig:');
    expect(source).toContain('failedGuildIds: res.failedGuildIds');
  });

  it('startet unabhaengige AI-Hintergrundlogik auch nach einem isolierten Guild-Deploy-Fehler', () => {
    const deployCatch = source.indexOf("logger.error('Per-Guild Command-Sync Fehler:'");
    const aiStart = source.indexOf('await startAiBackgroundLoops(client)');
    expect(deployCatch).toBeGreaterThanOrEqual(0);
    expect(aiStart).toBeGreaterThan(deployCatch);
    expect(source).toContain("logger.error('AI-Hintergrundruntime konnte nicht gestartet werden:'");
  });
});
