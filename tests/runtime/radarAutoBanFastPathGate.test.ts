import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const source = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Radar auto-ban username + event-driven fast path gate', () => {
  it('keeps all safety polling intervals as fallback while wiring immediate stage kicks', () => {
    const adm = source('src/modules/nitrado/adm/admLiveSyncCron.ts');
    const radar = source('src/modules/radar/runtime.ts');
    const autoBan = source('src/modules/radar/autoBanRuntime.ts');
    const jobs = source('src/modules/nitrado/jobWorker.ts');

    expect(adm).toContain('const POLL_INTERVAL_MS = 30_000;');
    expect(radar).toContain('const POLL_INTERVAL_MS = 15_000;');
    expect(autoBan).toContain('const POLL_INTERVAL_MS = 15_000;');
    expect(jobs).toContain('const JOB_POLL_INTERVAL_MS = 10_000;');

    expect(adm).toContain("import { kickRadarRuntime } from '../../radar/runtime';");
    expect(adm).toContain('if (result.events.length > 0)');
    expect(adm).toContain('kickRadarRuntime();');

    expect(radar).toContain("import { kickRadarAutoBanRuntime } from './autoBanRuntime';");
    expect(radar).toContain('if (definition.punitive) kickRadarAutoBanRuntime();');

    expect(autoBan).toContain("import { kickNitradoJobWorker } from '../nitrado/jobWorker';");
    expect(autoBan).toContain("if (outcome.kind === 'APPLIED' && outcome.queued) kickNitradoJobWorker();");
  });

  it('separates the GUID policy subject from the visible Nitrado ban username', () => {
    const autoBan = source('src/modules/radar/autoBanRuntime.ts');
    const outbox = source('src/modules/bans/banOutbox.ts');
    const worker = source('src/modules/nitrado/jobWorker.ts');
    const model = source('prisma/server-ban-remote-identity.prisma');

    expect(autoBan).toContain('subjectIdentifier: event.actorGameId');
    expect(autoBan).toContain('remoteIdentifier: actorName');
    expect(autoBan).toContain("{ remoteIdentifier: validation.remoteIdentifier }");

    expect(outbox).toContain('encryptedRemoteIdentifier?: string;');
    expect(outbox).toContain('subjectIdentifierEnc');
    expect(outbox).toContain('whitelistIdentifier: identifier');

    expect(worker).toContain('client.addToBanlist(conn.nitradoServerId, sensitiveRemoteIdentifier)');
    expect(worker).toContain('client.removeFromWhitelist(conn.nitradoServerId, sensitiveIdentifier)');

    expect(model).toContain('identifierEnc        String');
    expect(model).toContain('subjectIdentifierEnc String?');
  });
});
