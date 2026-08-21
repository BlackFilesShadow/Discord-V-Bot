import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
// CommonJS helper (scripts/resolve-bash.js) — avoid WSL stub bash on Windows.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { resolveBash } = require('../../scripts/resolve-bash') as {
  resolveBash: () => string | null;
};

const SCRIPT = path.resolve(process.cwd(), 'deploy/ensure-metrics-token.sh');

function run(envText: string) {
  const dir = mkdtempSync(path.join(tmpdir(), 'vbot-metrics-'));
  const envFile = path.join(dir, '.env');
  writeFileSync(envFile, envText, { mode: 0o600 });
  const bash = resolveBash();
  if (!bash) {
    throw new Error('No usable bash found (install Git Bash or set GIT_BASH).');
  }
  const result = spawnSync(bash, [SCRIPT, envFile], { encoding: 'utf8' });
  return {
    ...result,
    env: readFileSync(envFile, 'utf8'),
  };
}

describe('deploy metrics token bootstrap', () => {
  it('veraendert eine bewusst deaktivierte Metrics-Konfiguration nicht', () => {
    const input = 'METRICS_ENABLED=false\nMETRICS_TOKEN=\nOTHER=value\n';
    const result = run(input);

    expect(result.status).toBe(0);
    expect(result.env).toBe(input);
  });

  it('behaelt einen bereits ausreichend langen Token unveraendert', () => {
    const token = 'a'.repeat(64);
    const result = run(`METRICS_ENABLED=true\nMETRICS_TOKEN=${token}\n`);

    expect(result.status).toBe(0);
    expect(result.env).toContain(`METRICS_TOKEN=${token}`);
    expect(result.stdout).not.toContain(token);
    expect(result.stderr).not.toContain(token);
  });

  it('erzeugt bei explizit aktivierten Metrics genau einmal ein starkes Secret ohne es zu loggen', () => {
    const first = run('METRICS_ENABLED=true\nMETRICS_TOKEN=\n');

    expect(first.status).toBe(0);
    const match = first.env.match(/^METRICS_TOKEN=([0-9a-f]{64})$/m);
    expect(match).not.toBeNull();
    const generated = match![1];
    expect(first.stdout).not.toContain(generated);
    expect(first.stderr).not.toContain(generated);

    const second = run(first.env);
    expect(second.status).toBe(0);
    expect(second.env).toBe(first.env);
    expect(second.stdout).not.toContain(generated);
    expect(second.stderr).not.toContain(generated);
  });
});
