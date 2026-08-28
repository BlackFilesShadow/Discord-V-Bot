import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const service = fs.readFileSync(path.join(ROOT, 'src/modules/linking/adminForceLink.ts'), 'utf8');
const cron = fs.readFileSync(path.join(ROOT, 'src/modules/nitrado/adm/admPostProcessCron.ts'), 'utf8');

describe('admin force-link delayed reconciliation gate', () => {
  it('retries provisional links from the ADM postprocessor and only emits resolved real gameIds', () => {
    expect(cron).toContain('reconcileAdminForcedLinks');
    expect(service).toContain("AND \"forcedPlayerName\" IS NOT NULL");
    expect(service).toContain('if (!result.ok || !result.gameId) continue;');
    expect(service).toContain('gameId: result.gameId');
  });
});
