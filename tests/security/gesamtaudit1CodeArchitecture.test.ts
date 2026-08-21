import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/gesamtaudit-1-code-architecture-matrix.json'), 'utf8'));
const v2 = fs.readFileSync(path.resolve('src/dashboard/routes/v2.ts'), 'utf8');
const secDir = path.resolve('tests/security');
const arch = fs.readdirSync(secDir).filter((f) => /Architecture\.test\.ts$/.test(f));

describe('Stage 60 gesamtaudit 1 code architecture', () => {
  it('keeps v2 auth mount and architecture gate corpus', () => {
    expect(m.stage).toBe(60);
    expect(v2).toContain('v2Router.use(requireAuth)');
    expect(v2).toContain('v2Router.use(idempotency)');
    expect(arch.length).toBeGreaterThanOrEqual(20);
  });
});
