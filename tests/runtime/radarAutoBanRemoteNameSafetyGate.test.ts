import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (relativePath: string): string => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('Radar auto-ban remote-name safety gate', () => {
  it('requires a revalidated player name before a punitive remote write', () => {
    const runtime = read('src/modules/radar/autoBanRuntime.ts');
    expect(runtime).toContain("code: 'ACTOR_NAME_INVALID_OR_MISSING'");
    expect(runtime).toContain("(candidate.playerName?.trim() ?? '') === eventActorName");
    expect(runtime).toContain('subjectIdentifier: event.actorGameId');
    expect(runtime).toContain('remoteIdentifier: actorName');
  });
});
