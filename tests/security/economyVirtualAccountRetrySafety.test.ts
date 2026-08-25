import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtuelle Konten — Retry- und Replay-Sicherheit', () => {
  const legacyService = read('src/modules/economy/virtualAccounts.ts');
  const safety = read('src/modules/economy/virtualAccountMoneySafety.ts');
  const safetyRoute = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');
  const panel = read('dashboard-ui/src/components/economy/VirtualAccountsControlPanel.tsx');
  const api = read('dashboard-ui/src/lib/api.ts');

  it('weist Idempotency-Replays mit abweichenden Buchungsdaten fail-closed zurueck', () => {
    expect(legacyService).toContain('async function assertReplayMatches');
    expect(safety).toContain("throw new Error('Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.')");
    expect(safety).toContain('actual.virtualAccountId === expected.virtualAccountId');
    expect(safety).toContain('actual.delta === expected.delta');
    expect(safety).toContain('actual.sourcePocket === expected.sourcePocket');
    expect(safety).toContain('actual.actorDiscordId === expected.actorDiscordId');
    expect(safety).toContain('actual.userDiscordId === expected.userDiscordId');
    expect(safety).toContain('actual.reason === expected.reason');
    expect(safety).toContain('actual.sourceRef === expected.sourceRef');
  });

  it('priorisiert eine stabile Dashboard-Operation-ID und validiert deren Format vor dem Money-Service', () => {
    expect(safetyRoute).toContain("const value = typeof body.operationId === 'string' ? body.operationId.trim() : '';");
    expect(safetyRoute).toContain("if (!/^[A-Za-z0-9._:-]{1,80}$/.test(key))");
    expect(safetyRoute).toContain('safePayoutVirtualAccountToUser({');
  });

  it('behaelt die Payout-Operation-ID bei einem fehlgeschlagenen Retry und rotiert sie bei Payload-Aenderung', () => {
    expect(panel).toContain('const [operationId, setOperationId] = useState(createIdempotencyKey);');
    expect(panel).toContain('operationId,');
    expect(panel).toContain('setOperationId(createIdempotencyKey());');
    expect(panel).toContain("onError: (error: Error) => onDone({ ok: false, text: error.message }),");
  });

  it('nutzt den zentralen Generator fuer neue Dashboard-Mutationskeys und behaelt Pending-Keys fuer sichere Retries', () => {
    expect(api).toContain('export function createIdempotencyKey(): string');
    expect(api).toContain('const key = validStoredIdempotencyKey(stored) ? stored.trim() : createIdempotencyKey();');
    expect(api).toContain('lease = await acquireMutationIdempotencyKey(signature);');
    expect(api).toContain("headers['X-Idempotency-Key'] = lease.key;");
    const decode = api.indexOf('const result = await decode<T>(await fetchWithTimeout(');
    const release = api.indexOf('if (lease) releaseMutationIdempotencyKey(lease);', decode);
    expect(decode).toBeGreaterThanOrEqual(0);
    expect(release).toBeGreaterThan(decode);
  });
});
