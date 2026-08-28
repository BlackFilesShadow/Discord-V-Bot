import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/linking/adminForceLink.ts'), 'utf8');

describe('admin force-link identity integrity gate', () => {
  it('never derives identityHash from the provisional player name', () => {
    expect(source).not.toMatch(/identityHash\([^,]*(playerName|forcedPlayerName)/);
    expect(source).toContain('const hash = args.gameId ? identityHash(args.gameId, args.secret) : null;');
  });
});
