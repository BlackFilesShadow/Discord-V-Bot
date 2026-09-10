import fs from 'node:fs';
import path from 'node:path';

const read = (relative: string): string => fs.readFileSync(path.join(process.cwd(), relative), 'utf8');

describe('PLAYER_LIST SQL capacity architecture', () => {
  it('bounds active-file roster evidence to latest rows per identity with supporting partial indexes', () => {
    const runtime = read('src/modules/gameplayFeeds/runtime.ts');
    const migration = read('prisma/migrations/20260909104500_adm_player_roster_hotpath/migration.sql');
    expect(runtime.match(/SELECT DISTINCT ON/g)?.length).toBe(2);
    expect(runtime).toContain('PLAYER_CONNECTED');
    expect(runtime).toContain('PLAYER_DISCONNECTED');
    expect(runtime).toContain('PLAYER_POSITION');
    expect(migration).toContain('AdmEvent_roster_presence_latest_idx');
    expect(migration).toContain('AdmEvent_roster_position_latest_idx');
  });
});
