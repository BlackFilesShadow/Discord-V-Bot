import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(__dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

describe('virtuelle Konten — Retry- und Replay-Sicherheit', () => {
  const legacyService = read('src/modules/economy/virtualAccounts.ts');
  const safety = read('src/modules/economy/virtualAccountMoneySafety.ts');
  const configuration = read('src/modules/economy/virtualAccountConfiguration.ts');
  const managerSafety = read('src/modules/economy/virtualAccountManagerPanelSafety.ts');
  const safetyRoute = read('src/dashboard/routes/v2/economyVirtualAccountTreasurySafety.ts');
  const v2 = read('src/dashboard/routes/v2.ts');
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

  it('berechnet die erste Einzahlung erst nach Konto-, Finance- und Config-Lock', () => {
    expect(safety).not.toContain('depositUserIntoVirtualAccount');
    const depositStart = safety.indexOf('export async function safeDepositUserIntoVirtualAccount');
    const accountLock = safety.indexOf('LockedDepositAccountRow[]>(', depositStart);
    const financeLock = safety.indexOf('LockedDepositFinanceRow[]>(', depositStart);
    const configLock = safety.indexOf('LIMIT 1 FOR SHARE', depositStart);
    const conversion = safety.indexOf('convertPlayerToLockedAccount(args.playerAmount', depositStart);
    const debit = safety.indexOf('UPDATE "EconomyAccount" SET "walletBalance"', depositStart);
    expect(accountLock).toBeGreaterThan(depositStart);
    expect(financeLock).toBeGreaterThan(accountLock);
    expect(configLock).toBeGreaterThan(financeLock);
    expect(conversion).toBeGreaterThan(configLock);
    expect(debit).toBeGreaterThan(conversion);
    expect(safety).toContain('await assertDepositPlayerReplay({');
    expect(safety).toContain('}, raw);');
    expect(safety).toContain('await writeDepositPlayerLedger(raw, {');
  });

  it('bindet Pocket-Transfer-Replays an Richtung UND Betrag', () => {
    expect(safety).toContain('const sourceRef = `pocket-transfer:${args.from}->${args.to}:${args.amount.toString()}`;');
    expect(safety).toContain("entryType: 'POCKET_TRANSFER'");
    expect(safety).toContain('sourceRef,');
    const replayCheck = safety.indexOf('const previous = await replay(key, raw);', safety.indexOf('safeTransferVirtualPocket'));
    const firstDebit = safety.indexOf('if (args.from === \'WALLET\')', replayCheck);
    expect(replayCheck).toBeGreaterThan(-1);
    expect(firstDebit).toBeGreaterThan(replayCheck);
  });

  it('validiert Payout-Replays zusaetzlich gegen Spielerbetrag und Ziel-Pocket', () => {
    expect(safety).toContain('async function assertPayoutPlayerReplay');
    expect(safety).toContain("walletDelta: args.targetPocket === 'WALLET' ? args.playerAmount : 0n");
    expect(safety).toContain("bankDelta: args.targetPocket === 'BANK' ? args.playerAmount : 0n");
    expect(safety).toContain('playerAmount: result.playerCredited');
    expect(safety).toContain('anderen Auszahlungsziel, Ziel-Pocket oder Spielerbetrag');
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

  it('friert Waehrung und Wechselkurs unter denselben DB-Locks ein sobald Guthaben vorhanden ist', () => {
    expect(configuration).toContain('LIMIT 1 FOR UPDATE');
    expect(configuration).toContain('const funded = account.balance + currentFinance.bankBalance > 0n;');
    expect(configuration).toContain('const currencyChanged = currencyKey(prepared.currencyName) !== currencyKey(currentFinance.currencyName);');
    expect(configuration).toContain('funded && (currencyChanged || exchangeChanged(currentFinance, prepared))');
    expect(configuration).toContain('Waehrung oder Wechselkurs kann bei vorhandenem Wallet- oder Bankguthaben nicht geaendert werden.');
  });

  it('persistiert Permission-Recovery vor Discord-Mutationen und loescht Tracking erst nach erfolgreicher Rueckgabe', () => {
    const recovery = managerSafety.indexOf('await persistRecoveryPanel({');
    const everyoneDeny = managerSafety.indexOf('await channel.permissionOverwrites.edit(guild.roles.everyone.id, { ViewChannel: false }');
    expect(recovery).toBeGreaterThan(-1);
    expect(everyoneDeny).toBeGreaterThan(recovery);
    expect(managerSafety).toContain('await restorePanelStrict(client, previous, tracked);');
    expect(managerSafety).toContain('await restoreAccessStrict(channel, row, \'V-Bot Kontoverwalter entfernt\');');
    expect(managerSafety).not.toContain("restoreAccessStrict(channel, row, 'V-Bot Kontoverwalter entfernt').catch");
    expect(safetyRoute).toContain('configureVirtualManagerPanelSafe');
    expect(safetyRoute).toContain('refreshConfiguredVirtualManagerPanelSafe');
  });

  it('schuetzt auch den generischen DEV-Router mit der kanonischen GlobalDeveloperIdentity', () => {
    expect(v2).toContain("v2Router.use('/dev', requireGlobalDeveloperIdentity, devRouter);");
    expect(v2).not.toContain("v2Router.use('/dev', devRouter);");
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
