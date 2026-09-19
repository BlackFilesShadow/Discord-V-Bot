import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Radar auto-ban whitelist subject gate', () => {
  it('keeps whitelist cancellation/removal bound to the internal GUID subject', () => {
    const autoBan = read('src/modules/radar/autoBanRuntime.ts');
    const worker = read('src/modules/nitrado/jobWorker.ts');
    expect(autoBan).toContain('gameId: validation.subjectIdentifier');
    expect(worker).toContain('client.removeFromWhitelist(conn.nitradoServerId, sensitiveIdentifier)');
    expect(worker).toContain('client.addToBanlist(conn.nitradoServerId, sensitiveRemoteIdentifier)');
  });
});
