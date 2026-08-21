import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/gesamtaudit-3-production-reality-matrix.json'), 'utf8'));
const env = fs.readFileSync(path.resolve('.env.example'), 'utf8');

describe('Stage 62 gesamtaudit 3 production reality', () => {
  it('keeps deploy surfaces and safe metrics default', () => {
    expect(m.stage).toBe(62);
    expect(fs.existsSync(path.resolve('Dockerfile'))).toBe(true);
    expect(fs.existsSync(path.resolve('docker-compose.yml'))).toBe(true);
    expect(fs.existsSync(path.resolve('deploy'))).toBe(true);
    expect(env).toContain('METRICS_ENABLED=false');
    expect(env).toContain('SESSION_SECRET=');
  });
});
