import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/gesamtaudit-2-couplings-matrix.json'), 'utf8'));
const auth = fs.readFileSync(path.resolve('src/dashboard/middleware/auth.ts'), 'utf8');
const incident = fs.readFileSync(path.resolve('src/dashboard/routes/v2/devIncident.ts'), 'utf8');

describe('Stage 61 gesamtaudit 2 couplings', () => {
  it('keeps membership coupling and incident fail-closed', () => {
    expect(m.stage).toBe(61);
    expect(auth).toContain('GUILD_MEMBERSHIP_REQUIRED');
    expect(incident).toMatch(/operationalActions\s*=\s*\[\s*\]|OPERATIONAL_INCIDENT_ACTIONS/);
  });
});
