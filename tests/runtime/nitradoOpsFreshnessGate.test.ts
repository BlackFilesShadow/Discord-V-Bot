import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';

const read = (relative: string): string => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

function expectOrdered(source: string, anchors: string[]): void {
  let previous = -1;
  for (const anchor of anchors) {
    const index = source.indexOf(anchor, previous + 1);
    expect(index).toBeGreaterThan(previous);
    previous = index;
  }
}

describe('Nitrado-1Y Ops freshness architecture', () => {
  it('maintenance revalidation locks before fresh token read, remote validation and repository write', () => {
    const source = read('src/modules/nitrado/maintenanceRevalidate.ts');
    expectOrdered(source, [
      'tryAcquireNitradoConfigMutationLock(candidate.id)',
      'prisma.nitradoConnection.findFirst',
      'decrypt(fresh.encryptedToken',
      'validateTokenDetailed()',
      "if (result.kind === 'VALID')",
      'markValidated(',
    ]);
    expect(source).toContain("guildId: candidate.guildId");
    expect(source).toContain("status: { in: ['ACTIVE', 'EXPIRED'] }");
    expect(source).toContain("setStatus(asGuildId(fresh.guildId), asNitradoConnId(fresh.id), 'EXPIRED')");
  });

  it('revalidate script is candidate-only and contains no direct token decrypt, client or DB status mutation', () => {
    const source = read('src/scripts/nitradoRevalidate.ts');
    expect(source).toContain("from '../modules/nitrado/maintenanceRevalidate'");
    expect(source).toContain('revalidateConnectionMaintenanceOnce(candidate)');
    expect(source).not.toContain("from '../utils/security'");
    expect(source).not.toContain('new NitradoClient');
    expect(source).not.toContain('nitradoConnection.updateMany');
    expect(source).not.toContain('encryptedToken: true');
  });

  it('diagnostics use only canonical nitradoServerId and refresh token/service under the connection lock', () => {
    const source = read('src/scripts/nitradoDiag.ts');
    const snapshot = source.indexOf('async function readDiagSnapshot');
    expectOrdered(source.slice(snapshot), [
      'tryAcquireNitradoConfigMutationLock(candidate.id)',
      'prisma.nitradoConnection.findFirst',
      'nitradoServerId: { not: null }',
      'encryptedToken: true',
    ]);
    expect(source).not.toContain('serviceId: true');
    expect(source).not.toContain('serviceId ??');
    expect(source).toContain('const svc = snapshot.nitradoServerId;');
  });

  it('DEV status surfaces never prefer or read the legacy serviceId field', () => {
    const status = read('src/dashboard/routes/v2/devStatus.ts');
    const mirror = read('src/dashboard/routes/v2/devNitradoMirror.ts');

    for (const source of [status, mirror]) {
      expect(source).not.toContain('serviceId: true');
      expect(source).not.toContain('serviceId ??');
      expect(source).not.toContain('c.serviceId');
      expect(source).not.toContain('row.serviceId');
    }
    expect(status).toContain('serviceId: c.nitradoServerId ?? null');
    expect(mirror).toContain('serviceId: row.nitradoServerId ?? null');
  });
});
