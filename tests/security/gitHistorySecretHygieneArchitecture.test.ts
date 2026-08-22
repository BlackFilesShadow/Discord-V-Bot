import fs from 'node:fs';
import { normalizeSourceNewlines } from '../helpers/sourceText';
import path from 'node:path';
import { execSync } from 'node:child_process';

const read = (relative: string) => normalizeSourceNewlines(fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8'));

const matrix = JSON.parse(read('docs/git-history-secret-hygiene-matrix.json')) as {
  stage: number;
  contracts: { historyGate: string };
  results: { currentTreeHits: number; trackedEnvFiles: string[]; status: string };
  verification: {
    workflow: string;
    job: string;
    checkoutDepth: number;
    scanner: string;
    blocking: boolean;
    gateState: string;
  };
  followUp: unknown[];
};

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  /discord\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/i,
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bsk-[A-Za-z0-9]{32,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /DISCORD_TOKEN\s*=\s*['"]?[A-Za-z0-9._-]{50,}/i,
  /NITRADO_TOKEN\s*=\s*['"]?[A-Za-z0-9._-]{20,}/i,
];

const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|eot|map|lock|bin)$/i;

describe('Stage 39 git history secret hygiene', () => {
  it('documents a blocking full-history posture', () => {
    expect(matrix.stage).toBe(39);
    expect(matrix.results.status).toBe('full-history-blocking-gate-wired');
    expect(matrix.results.currentTreeHits).toBe(0);
    expect(matrix.results.trackedEnvFiles).toEqual(['.env.example']);
    expect(matrix.verification.workflow).toBe('.github/workflows/ci.yml');
    expect(matrix.verification.job).toBe('security');
    expect(matrix.verification.checkoutDepth).toBe(0);
    expect(matrix.verification.scanner).toBe('gitleaks/gitleaks-action@v3');
    expect(matrix.verification.blocking).toBe(true);
    expect(matrix.contracts.historyGate).toMatch(/blocking Gitleaks scan/i);
    expect(matrix.followUp).toEqual([]);
  });

  it('keeps the CI full-history secret scan fail-closed and blocking', () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toMatch(/security:\n\s+name: Security Audit/);
    expect(ci).toMatch(/Checkout full history for secret scan[\s\S]*fetch-depth:\s*0/);
    expect(ci).toMatch(/Full-history secret scan \(blocking\)[\s\S]*gitleaks\/gitleaks-action@v3/);

    const scanBlock = ci.match(/- name: Full-history secret scan \(blocking\)[\s\S]*?(?=\n\s+- name: Setup Node\.js)/)?.[0] ?? '';
    expect(scanBlock).not.toMatch(/continue-on-error:\s*true/);
    expect(scanBlock).not.toMatch(/\|\|\s*true/);
    expect(scanBlock).not.toMatch(/\|\|\s*echo/);
  });

  it('does not track real .env and keeps example placeholder-only', () => {
    const tracked = execSync('git ls-files .env .env.*', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean);
    expect(tracked).toEqual(['.env.example']);
    const example = read('.env.example');
    expect(example).toMatch(/DISCORD|TOKEN|SECRET|PASSWORD/i);
    expect(example).not.toMatch(/DISCORD_TOKEN\s*=\s*['"]?[A-Za-z0-9._-]{50,}/);
  });

  it('scans tracked source files for high-risk secret patterns', () => {
    const files = execSync('git ls-files', { encoding: 'utf8' })
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(f => !SKIP_EXT.test(f))
      .filter(f => !f.includes('package-lock.json'));

    const hits: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
      } catch {
        continue;
      }
      if (file.replace(/\\/g, '/').endsWith('tests/security/gitHistorySecretHygieneArchitecture.test.ts')) continue;
      if (file.replace(/\\/g, '/').endsWith('docs/git-history-secret-hygiene-matrix.json')) continue;
      for (const re of SECRET_PATTERNS) {
        if (re.test(text)) hits.push(`${file} :: ${re}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
