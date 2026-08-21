import fs from 'node:fs';
import path from 'node:path';

const m = JSON.parse(fs.readFileSync(path.resolve('docs/passport-discord-migration-matrix.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
const auth = fs.readFileSync(path.resolve('src/dashboard/routes/auth.ts'), 'utf8');

describe('Stage 54 passport-discord migration', () => {
  it('keeps custom OAuth as canonical auth path', () => {
    expect(m.stage).toBe(54);
    expect(auth).toContain("authRouter.get('/login'");
    expect(auth).toContain('generatePKCE');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    // If passport-discord is present it is tracked; auth must not import it.
    if (deps['passport-discord']) {
      expect(auth).not.toContain('passport-discord');
    }
    expect(auth).not.toMatch(/from ['"]passport['"]/);
  });
});
