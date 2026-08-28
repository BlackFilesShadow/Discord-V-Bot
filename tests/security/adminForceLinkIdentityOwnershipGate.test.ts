import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src/modules/linking/adminForceLink.ts'), 'utf8');

describe('admin force-link ownership gate', () => {
  it('checks both name and resolved identity ownership before writing', () => {
    expect(source).toContain("reason: 'PLAYER_NAME_TAKEN'");
    expect(source).toContain("reason: 'IDENTITY_TAKEN'");
    expect(source).toContain('forcedPlayerName');
    expect(source).toContain('identityHash');
  });
});
