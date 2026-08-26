import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import {
  getVirtualAccountById,
  type EconomyPocket,
  type VirtualAccountRawDb,
  type VirtualAccountRow,
} from './virtualAccounts';
import {
  ensureVirtualAccountFinance,
  payoutVirtualAccountToUser,
  removeVirtualAccountAmount,
  type VirtualAccountFinance,
} from './virtualAccountFinance';

interface ReplayRow {
  virtualAccountId: string;
  delta: bigint;
  entryType: string;
  sourcePocket: string | null;
  actorDiscordId: string | null;
  userDiscordId: string | null;
  reason: string | null;
  sourceRef: string | null;
}

interface PlayerLedgerReplayRow {
  userDiscordId: string;
  walletDelta: bigint;
  bankDelta: bigint;
  sourceRef: string | null;
}

interface LockedDepositAccountRow {
  kind: string;
  name: string;
  balance: bigint;
  status: string;
  acceptUserTransfers: boolean;
}

interface LockedDepositFinanceRow {
  bankBalance: bigint;
  currencyName: string;
  exchangePlayerUnits: bigint | null;
  exchangeAccountUnits: bigint | null;
}

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

function externalKey(value: string): string {
  const clean = value.normalize('NFKC').trim();
  if (!clean || clean.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(clean)) throw new Error('Idempotency-Key ungueltig.');
  return clean;
}

function operationKey(prefix: string, guildId: GuildId, connId: NitradoConnId, external: string): string {
  return `${prefix}:${guildId}:${connId}:${externalKey(external)}`;
}

function normalizedReason(value: string | undefined, fallback: string): string {
  return (value?.trim() || fallback).slice(0, 180);
}

function strictReason(value: string, label: string): string {
  const clean = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (clean.length < 3 || clean.length > 180) throw new Error(`${label} muss 3..180 Zeichen enthalten.`);
  return clean;
}

async function assertCustomAccount(guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<VirtualAccountRow> {
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  if (account.kind !== 'CUSTOM') {
    throw new Error('Lotterie- und Markt-Systemkonten duerfen nur durch ihre jeweilige Fachfunktion Geld bewegen.');
  }
  return account;
}

async function replay(key: string, db: VirtualAccountRawDb = rawDb()): Promise<ReplayRow | null> {
  const rows = await db.$queryRawUnsafe<ReplayRow[]>(
    'SELECT "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1',
    key,
  );
  return rows[0] ?? null;
}

function assertReplay(actual: ReplayRow | null, expected: ReplayRow): void {
  const same = actual !== null
    && actual.virtualAccountId === expected.virtualAccountId
    && actual.delta === expected.delta
    && actual.entryType === expected.entryType
    && actual.sourcePocket === expected.sourcePocket
    && actual.actorDiscordId === expected.actorDiscordId
    && actual.userDiscordId === expected.userDiscordId
    && actual.reason === expected.reason
    && actual.sourceRef === expected.sourceRef;
  if (!same) throw new Error('Idempotency-Key wurde mit anderen Buchungsdaten wiederverwendet.');
}

async function playerLedgerReplay(
  key: string,
  guildId: GuildId,
  connId: NitradoConnId,
  db: VirtualAccountRawDb = rawDb(),
): Promise<PlayerLedgerReplayRow | null> {
  const rows = await db.$queryRawUnsafe<PlayerLedgerReplayRow[]>(
    'SELECT "userDiscordId", "walletDelta", "bankDelta", "sourceRef" FROM "EconomyLedgerEntry" WHERE "idempotencyKey"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
    `${key}:user`,
    String(guildId),
    String(connId),
  );
  return rows[0] ?? null;
}

function assertPlayerLedgerReplay(actual: PlayerLedgerReplayRow | null, expected: PlayerLedgerReplayRow, errorMessage: string): void {
  const same = actual !== null
    && actual.userDiscordId === expected.userDiscordId
    && actual.walletDelta === expected.walletDelta
    && actual.bankDelta === expected.bankDelta
    && actual.sourceRef === expected.sourceRef;
  if (!same) throw new Error(errorMessage);
}

async function assertDepositPlayerReplay(args: {
  operationKey: string;
  guildId: GuildId;
  connId: NitradoConnId;
  accountId: string;
  userId: UserDiscordId;
  sourcePocket: EconomyPocket;
  playerAmount: bigint;
}, db: VirtualAccountRawDb = rawDb()): Promise<void> {
  assertPlayerLedgerReplay(
    await playerLedgerReplay(args.operationKey, args.guildId, args.connId, db),
    {
      userDiscordId: String(args.userId),
      walletDelta: args.sourcePocket === 'WALLET' ? -args.playerAmount : 0n,
      bankDelta: args.sourcePocket === 'BANK' ? -args.playerAmount : 0n,
      sourceRef: `virtual-account:${args.accountId}`,
    },
    'Idempotency-Key wurde mit einem anderen urspruenglichen Spielerbetrag wiederverwendet.',
  );
}

async function assertPayoutPlayerReplay(args: {
  operationKey: string;
  guildId: GuildId;
  connId: NitradoConnId;
  accountId: string;
  userId: UserDiscordId;
  targetPocket: EconomyPocket;
  playerAmount: bigint;
}): Promise<void> {
  assertPlayerLedgerReplay(
    await playerLedgerReplay(args.operationKey, args.guildId, args.connId),
    {
      userDiscordId: String(args.userId),
      walletDelta: args.targetPocket === 'WALLET' ? args.playerAmount : 0n,
      bankDelta: args.targetPocket === 'BANK' ? args.playerAmount : 0n,
      sourceRef: `virtual-account:${args.accountId}`,
    },
    'Idempotency-Key wurde mit einem anderen Auszahlungsziel, Ziel-Pocket oder Spielerbetrag wiederverwendet.',
  );
}

function currencyKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('de-DE');
}

function convertPlayerToLockedAccount(amount: bigint, serverCurrencyName: string, finance: LockedDepositFinanceRow): bigint {
  if (currencyKey(serverCurrencyName) === currencyKey(finance.currencyName)) return amount;
  if (!finance.exchangePlayerUnits || !finance.exchangeAccountUnits) {
    throw new Error(`Keine Wechselrate von ${serverCurrencyName} zu ${finance.currencyName} konfiguriert.`);
  }
  const numerator = amount * finance.exchangeAccountUnits;
  if (numerator % finance.exchangePlayerUnits !== 0n) {
    throw new Error('Betrag kann mit dem konfigurierten Wechselkurs nicht ohne Rundungsverlust umgerechnet werden.');
  }
  return numerator / finance.exchangePlayerUnits;
}

async function writeDepositPlayerLedger(raw: VirtualAccountRawDb, args: {
  key: string;
  guildId: GuildId;
  connId: NitradoConnId;
  userId: UserDiscordId;
  sourcePocket: EconomyPocket;
  playerAmount: bigint;
  reason: string;
  accountId: string;
  accountName: string;
}): Promise<void> {
  const walletDelta = args.sourcePocket === 'WALLET' ? -args.playerAmount : 0n;
  const bankDelta = args.sourcePocket === 'BANK' ? -args.playerAmount : 0n;
  const ledgerReason = `${args.reason} -> ${args.accountName}`.slice(0, 180);
  const sourceRef = `virtual-account:${args.accountId}`;

  await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyTransaction" ("id", "guildId", "nitradoConnId", "userDiscordId", "delta", "type", "reason", "actorDiscordId", "counterpartDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,\'PAY\'::"EconomyTxType",$6,$7,NULL,CURRENT_TIMESTAMP)',
    randomUUID(),
    String(args.guildId),
    String(args.connId),
    String(args.userId),
    -args.playerAmount,
    ledgerReason,
    String(args.userId),
  );
  const changed = await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyLedgerEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "userDiscordId", "walletDelta", "bankDelta", "type", "reason", "buckets", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,\'PAY\'::"EconomyTxType",$8,0,$9,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
    randomUUID(),
    `${args.key}:user`,
    String(args.guildId),
    String(args.connId),
    String(args.userId),
    walletDelta,
    bankDelta,
    ledgerReason,
    sourceRef,
  );
  if (changed !== 1) throw new Error('User-Ledger-Idempotenzkonflikt.');
}

/**
 * Die erste Einzahlung ist zugleich der Moment, in dem ein bis dahin leeres
 * Konto finanziert wird. Deshalb werden Konto und Finanzprofil zuerst in der
 * gleichen Reihenfolge wie Konfigurationsaenderungen gelockt und der FX-Wert
 * erst danach berechnet. So kann kein parallel erlaubtes Zero-Balance-FX-Update
 * zwischen Berechnung und Buchung geraten.
 */
export async function safeDepositUserIntoVirtualAccount(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  userDiscordId: UserDiscordId;
  sourcePocket: EconomyPocket;
  playerAmount: bigint;
  reason?: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow; finance: VirtualAccountFinance; playerDebited: bigint; accountCredited: bigint }> {
  await assertCustomAccount(args.guildId, args.nitradoConnId, args.accountId);
  if (args.playerAmount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
  if (args.sourcePocket !== 'WALLET' && args.sourcePocket !== 'BANK') throw new Error('Quellkonto ungueltig.');
  await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);

  const key = operationKey('virtual-deposit', args.guildId, args.nitradoConnId, args.idempotencyKey);
  const reason = normalizedReason(args.reason, 'Einzahlung auf virtuelles Konto');
  const result = await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const accountRows = await raw.$queryRawUnsafe<LockedDepositAccountRow[]>(
      'SELECT "kind"::text AS kind, "name", "balance", "status"::text AS status, "acceptUserTransfers" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const account = accountRows[0];
    if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
    if (account.kind !== 'CUSTOM') throw new Error('Lotterie- und Markt-Systemkonten duerfen nur durch ihre jeweilige Fachfunktion Geld bewegen.');
    if (account.status !== 'ACTIVE') throw new Error('Virtuelles Konto ist nicht aktiv.');
    if (!account.acceptUserTransfers) throw new Error('Dieses Konto nimmt keine direkten Einzahlungen an.');

    const financeRows = await raw.$queryRawUnsafe<LockedDepositFinanceRow[]>(
      'SELECT "bankBalance", "currencyName", "exchangePlayerUnits", "exchangeAccountUnits" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const finance = financeRows[0];
    if (!finance) throw new Error('Konto-Finanzprofil fehlt.');

    // Bestehende EconomyConfig-Zeilen werden fuer die Dauer der Buchung geteilt
    // gelockt. Ein paralleles Currency-Update derselben Zeile muss damit warten.
    const configRows = await raw.$queryRawUnsafe<Array<{ currencyName: string }>>(
      'SELECT "currencyName" FROM "EconomyConfig" WHERE "guildId"=$1 AND "nitradoConnId"=$2 LIMIT 1 FOR SHARE',
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const serverCurrencyName = configRows[0]?.currencyName ?? 'Coins';
    const accountAmount = convertPlayerToLockedAccount(args.playerAmount, serverCurrencyName, finance);
    if (accountAmount <= 0n) throw new Error('Umgerechneter Betrag muss groesser als 0 sein.');

    const expected: ReplayRow = {
      virtualAccountId: args.accountId,
      delta: accountAmount,
      entryType: 'USER_DEPOSIT',
      sourcePocket: args.sourcePocket,
      actorDiscordId: String(args.userDiscordId),
      userDiscordId: String(args.userDiscordId),
      reason,
      sourceRef: `virtual-account:${args.accountId}`,
    };
    const previous = await replay(key, raw);
    if (previous) {
      assertReplay(previous, expected);
      await assertDepositPlayerReplay({
        operationKey: key,
        guildId: args.guildId,
        connId: args.nitradoConnId,
        accountId: args.accountId,
        userId: args.userDiscordId,
        sourcePocket: args.sourcePocket,
        playerAmount: args.playerAmount,
      }, raw);
      return { booked: false, accountAmount };
    }

    const debited = args.sourcePocket === 'WALLET'
      ? await raw.$executeRawUnsafe(
        'UPDATE "EconomyAccount" SET "walletBalance"="walletBalance"-$4, "lifetimeSpent"="lifetimeSpent"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "walletBalance">=$4',
        String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId), args.playerAmount,
      )
      : await raw.$executeRawUnsafe(
        'UPDATE "EconomyAccount" SET "bankBalance"="bankBalance"-$4, "lifetimeSpent"="lifetimeSpent"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "bankBalance">=$4',
        String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId), args.playerAmount,
      );
    if (debited !== 1) throw new Error(args.sourcePocket === 'WALLET' ? 'Wallet zu klein.' : 'Bankguthaben zu klein.');

    const credited = await raw.$executeRawUnsafe(
      'UPDATE "EconomyVirtualAccount" SET "balance"="balance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
      accountAmount,
    );
    if (credited !== 1) throw new Error('Virtuelles Konto konnte nicht gutgeschrieben werden.');

    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'USER_DEPOSIT\',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)',
      randomUUID(),
      key,
      String(args.guildId),
      String(args.nitradoConnId),
      args.accountId,
      accountAmount,
      args.sourcePocket,
      String(args.userDiscordId),
      String(args.userDiscordId),
      reason,
      `virtual-account:${args.accountId}`,
    );
    await writeDepositPlayerLedger(raw, {
      key,
      guildId: args.guildId,
      connId: args.nitradoConnId,
      userId: args.userDiscordId,
      sourcePocket: args.sourcePocket,
      playerAmount: args.playerAmount,
      reason,
      accountId: args.accountId,
      accountName: account.name,
    });
    return { booked: true, accountAmount };
  });

  const [account, finance] = await Promise.all([
    getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId),
    ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId),
  ]);
  if (!account) throw new Error('Virtuelles Konto konnte nach Einzahlung nicht gelesen werden.');
  return {
    booked: result.booked,
    account,
    finance,
    playerDebited: args.playerAmount,
    accountCredited: result.accountAmount,
  };
}

/**
 * Pocket-Transfers werden hier selbst gebucht statt den historischen Helper zu
 * verwenden. Der Betrag ist Teil der persistierten Replay-Signatur, sodass ein
 * gleicher externer Idempotency-Key niemals fuer einen anderen Betrag wieder-
 * verwendet werden kann.
 */
export async function safeTransferVirtualPocket(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  actorDiscordId: UserDiscordId;
  from: EconomyPocket;
  to: EconomyPocket;
  amount: bigint;
  reason?: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow; finance: VirtualAccountFinance }> {
  await assertCustomAccount(args.guildId, args.nitradoConnId, args.accountId);
  if (args.from === args.to) throw new Error('Quell- und Ziel-Pocket muessen verschieden sein.');
  if (args.amount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
  await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);

  const key = operationKey('virtual-pocket', args.guildId, args.nitradoConnId, args.idempotencyKey);
  const reason = normalizedReason(args.reason, `${args.from} -> ${args.to}`);
  const sourceRef = `pocket-transfer:${args.from}->${args.to}:${args.amount.toString()}`;
  const expected: ReplayRow = {
    virtualAccountId: args.accountId,
    delta: 0n,
    entryType: 'POCKET_TRANSFER',
    sourcePocket: args.from,
    actorDiscordId: String(args.actorDiscordId),
    userDiscordId: null,
    reason,
    sourceRef,
  };

  const booked = await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const accountRows = await raw.$queryRawUnsafe<Array<{ balance: bigint; status: string }>>(
      'SELECT "balance", "status"::text AS status FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const account = accountRows[0];
    if (!account || account.status === 'ARCHIVED') throw new Error('Virtuelles Konto ist nicht verfuegbar.');

    const financeRows = await raw.$queryRawUnsafe<Array<{ bankBalance: bigint }>>(
      'SELECT "bankBalance" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    if (!financeRows[0]) throw new Error('Konto-Finanzprofil fehlt.');

    const previous = await replay(key, raw);
    if (previous) {
      assertReplay(previous, expected);
      return false;
    }

    if (args.from === 'WALLET') {
      const debit = await raw.$executeRawUnsafe(
        'UPDATE "EconomyVirtualAccount" SET "balance"="balance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "balance">=$4',
        args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount,
      );
      if (debit !== 1) throw new Error('Virtuelles Wallet hat zu wenig Guthaben.');
      const credit = await raw.$executeRawUnsafe(
        'UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"="bankBalance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
        args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount,
      );
      if (credit !== 1) throw new Error('Virtuelle Bank konnte nicht aktualisiert werden.');
    } else {
      const debit = await raw.$executeRawUnsafe(
        'UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"="bankBalance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "bankBalance">=$4',
        args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount,
      );
      if (debit !== 1) throw new Error('Virtuelle Bank hat zu wenig Guthaben.');
      const credit = await raw.$executeRawUnsafe(
        'UPDATE "EconomyVirtualAccount" SET "balance"="balance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
        args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount,
      );
      if (credit !== 1) throw new Error('Virtuelles Wallet konnte nicht aktualisiert werden.');
    }

    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,0,\'POCKET_TRANSFER\',$6,$7,NULL,$8,$9,CURRENT_TIMESTAMP)',
      randomUUID(), key, String(args.guildId), String(args.nitradoConnId), args.accountId,
      args.from, String(args.actorDiscordId), reason, sourceRef,
    );
    return true;
  });

  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto fehlt nach Pocket-Transfer.');
  return { booked, account, finance };
}

export async function safeRemoveVirtualAccountAmount(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  actorDiscordId: UserDiscordId;
  pocket: EconomyPocket;
  amount: bigint;
  reason: string;
}) {
  await assertCustomAccount(args.guildId, args.nitradoConnId, args.accountId);
  const reason = strictReason(args.reason, 'Remove-Grund');
  const result = await removeVirtualAccountAmount({ ...args, reason });
  if (!result.booked) {
    assertReplay(await replay(operationKey('virtual-remove', args.guildId, args.nitradoConnId, args.idempotencyKey)), {
      virtualAccountId: args.accountId,
      delta: -args.amount,
      entryType: 'MANAGER_REMOVE',
      sourcePocket: args.pocket,
      actorDiscordId: String(args.actorDiscordId),
      userDiscordId: null,
      reason,
      sourceRef: `virtual-account:${args.accountId}`,
    });
  }
  return result;
}

export async function safePayoutVirtualAccountToUser(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  actorDiscordId: UserDiscordId;
  toUserDiscordId: UserDiscordId;
  sourcePocket: EconomyPocket;
  targetPocket: EconomyPocket;
  accountAmount: bigint;
  reason: string;
}) {
  await assertCustomAccount(args.guildId, args.nitradoConnId, args.accountId);
  const reason = strictReason(args.reason, 'Auszahlungsgrund');
  const result = await payoutVirtualAccountToUser({ ...args, reason });
  if (!result.booked) {
    const key = operationKey('virtual-payout', args.guildId, args.nitradoConnId, args.idempotencyKey);
    assertReplay(await replay(key), {
      virtualAccountId: args.accountId,
      delta: -args.accountAmount,
      entryType: 'MANAGER_PAYOUT',
      sourcePocket: args.sourcePocket,
      actorDiscordId: String(args.actorDiscordId),
      userDiscordId: String(args.toUserDiscordId),
      reason,
      sourceRef: `virtual-account:${args.accountId}`,
    });
    await assertPayoutPlayerReplay({
      operationKey: key,
      guildId: args.guildId,
      connId: args.nitradoConnId,
      accountId: args.accountId,
      userId: args.toUserDiscordId,
      targetPocket: args.targetPocket,
      playerAmount: result.playerCredited,
    });
  }
  return result;
}
