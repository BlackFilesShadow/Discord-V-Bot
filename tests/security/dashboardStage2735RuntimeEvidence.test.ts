import fs from 'node:fs';
import path from 'node:path';
import { normalizeSourceNewlines } from '../helpers/sourceText';

const root = process.cwd();
const read = (relative: string): string =>
  normalizeSourceNewlines(fs.readFileSync(path.join(root, relative), 'utf8'));

describe('Stage 27-35 dashboard runtime evidence', () => {
  const e2e = 'dashboard-ui/e2e/stage-27-35-runtime-matrix.spec.ts';
  const slotUi = 'dashboard-ui/src/pages/ServerSlot.tsx';
  const api = 'dashboard-ui/src/lib/api.ts';

  it('pins consolidated runtime Playwright evidence for stages 27-35', () => {
    expect(fs.existsSync(path.join(root, e2e))).toBe(true);
    const source = read(e2e);
    expect(source).toContain('Stage 27 action: settings mutation pipeline');
    expect(source).toContain('X-Idempotency-Key');
    expect(source).toContain('Stage 28 pagination');
    expect(source).toContain('Stage 29 error states');
    expect(source).toContain('Stage 30 desktop completion 1280');
    expect(source).toContain('Stages 31-35 mobile viewports');
    expect(source).toContain('width: 320');
    expect(source).toContain('width: 360');
    expect(source).toContain('width: 375');
    expect(source).toContain('width: 390');
    expect(source).toContain('width: 430');
    for (const status of [400, 401, 403, 404, 409, 429, 500]) {
      expect(source).toContain(`status: ${status}`);
    }
    expect(source).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });

  it('settings mutations surface success and describeApiError failures (no silent fail)', () => {
    const ui = read(slotUi);
    expect(ui).toContain("from '@/lib/api'");
    expect(ui).toContain('describeApiError');
    expect(ui).toContain("title: 'Gespeichert'");
    expect(ui).toContain('onError:');
    expect(ui).toContain('settings-save-error');
    expect(ui).toContain('settings-load-error');
    expect(ui).not.toMatch(/catch\s*\([^)]*\)\s*\{\s*\}/);
  });

  it('central client keeps fail-closed taxonomy + mutation idempotency header', () => {
    const client = read(api);
    expect(client).toContain("headers['X-Idempotency-Key']");
    expect(client).toContain('describeApiError');
    expect(client).toContain("title: 'Nicht angemeldet'");
    expect(client).toContain("title: 'Keine Berechtigung'");
    expect(client).toContain("title: 'Serverfehler'");
    expect(client).toContain('throw new ApiError');
  });
});
