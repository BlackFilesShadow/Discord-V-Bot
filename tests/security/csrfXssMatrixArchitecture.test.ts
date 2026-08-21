import fs from 'node:fs';
import path from 'node:path';

const r = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
const m = JSON.parse(r('docs/csrf-xss-matrix.json')) as { stage: number; cases: unknown[] };
const auth = r('src/dashboard/routes/auth.ts');
const server = r('src/dashboard/server.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(ent.name)) out.push(p);
  }
  return out;
}

describe('Stage 41 CSRF XSS matrix', () => {
  it('documents cases', () => {
    expect(m.stage).toBe(41);
    expect(m.cases.length).toBeGreaterThanOrEqual(4);
  });

  it('keeps OAuth state and cookie/cors hardening', () => {
    expect(auth).toContain('generateCsrfToken');
    expect(auth).toContain('generatePKCE');
    expect(server).toContain("sameSite: 'lax'");
    expect(server).toContain('httpOnly: true');
    expect(server).toContain('credentials: true');
    expect(server).toContain('origin: config.dashboard.url');
  });

  it('does not bind dangerouslySetInnerHTML to raw request/user fields', () => {
    const root = path.resolve(process.cwd(), 'dashboard-ui/src');
    for (const file of walk(root)) {
      const t = fs.readFileSync(file, 'utf8');
      if (!t.includes('dangerouslySetInnerHTML')) continue;
      expect(t).not.toMatch(/dangerouslySetInnerHTML=\{\{\s*__html:\s*[^}]*\buser\b/);
      expect(t).not.toMatch(/dangerouslySetInnerHTML=\{\{\s*__html:\s*[^}]*\breq\./);
    }
  });
});
