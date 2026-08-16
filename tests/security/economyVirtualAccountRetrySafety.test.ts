import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtuelle Konten — Retry- und Replay-Sicherheit', () => {
  const service = read('src/modules/economy/virtualAccounts.ts');
  const route = read('src/dashboard/routes/v2/economyVirtualAccounts.ts');
  const panel = read('dashboard-ui/src/components/economy/VirtualAccountsPanel.tsx');
  const api = read('dashboard-ui/src/lib/api.ts');

  it('weist Idempotency-Replays mit abweichenden Buchungsdaten fail-closed zurueck', () => {
    expect(service).toContain('async function assertReplayMatches');
    expect(service).toContain("throw new Error('Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.')");
    expect(service).toContain('entry.virtualAccountId === expected.virtualAccountId');
    expect(service).toContain('entry.delta === expected.delta');
    expect(service).toContain('entry.userDiscordId === expected.userDiscordId');
    expect(service).toContain('entry.reason === expected.reason');
  });

  it('priorisiert die stabile Dashboard-Operation-ID vor einem transportbezogenen Header-Key', () => {
    expect(route).toContain("const bodyKey = typeof req.body?.operationId === 'string' ? req.body.operationId : null;");
    expect(route).toContain("const raw = bodyKey ?? req.get('X-Idempotency-Key');");
    expect(route).not.toContain("import { randomUUID } from 'node:crypto';");
  });

  it('behaelt die Payout-Operation-ID bei einem fehlgeschlagenen Retry und rotiert sie bei Payload-Aenderung', () => {
    expect(panel).toContain('const [payoutOperationId, setPayoutOperationId] = useState(createIdempotencyKey);');
    expect(panel).toContain('operationId: payoutOperationId');
    expect(panel).toContain('const updatePayout = (patch: Partial<typeof payout>) => {');
    expect(panel).toContain('setPayoutOperationId(createIdempotencyKey());');
    const onErrorLine = "onError: (error: Error) => setMessage({ ok: false, text: error.message }),";
    expect(panel).toContain(onErrorLine);
  });

  it('nutzt denselben zentralen Generator auch fuer normale Dashboard-Mutationsheader', () => {
    expect(api).toContain('export function createIdempotencyKey(): string');
    expect(api).toContain("headers['X-Idempotency-Key'] = createIdempotencyKey();");
  });
});
