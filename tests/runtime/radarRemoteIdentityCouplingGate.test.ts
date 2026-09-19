import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Radar remote ban identity coupling gate', () => {
  it('keeps remote username and GUID subject separate across repair and drift paths', () => {
    const reconcile = read('src/modules/bans/banReconciliation.ts');
    const driftDiscord = read('src/modules/nitrado/driftDiscord.ts');
    const driftRoute = read('src/dashboard/routes/v2/nitradoDrift.ts');

    expect(reconcile).toContain('subjectIdentifierEnc: true');
    expect(reconcile).toContain('storedIdentity.subjectIdentifier');
    expect(reconcile).toContain('remoteIdentifier: storedIdentity.remoteIdentifier');

    expect(driftDiscord).toContain('subjectIdentifierEnc: true');
    expect(driftDiscord).toContain('remoteDiffers ? { remoteIdentifier } : undefined');

    expect(driftRoute).toContain('subjectIdentifierEnc: true');
    expect(driftRoute).toContain('identifier: identity?.remoteIdentifier ?? null');
    expect(driftRoute).toContain('storedIdentity!.subjectIdentifier');
  });
});
