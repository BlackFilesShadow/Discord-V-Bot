import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import { createVirtualAccount, getVirtualAccountById, type EconomyPocket, type VirtualAccountRawDb, type VirtualAccountRow } from './virtualAccounts';
import { getConfig } from './repository';

export type VirtualAccountTextStyle = 'NORMAL' | 'BOLD' | 'ITALIC' | 'BOLD_ITALIC';
export type VirtualAccountPurpose = 'GENERAL' | 'BANK_TREASURY';

export interface VirtualAccountFinance {
  accountId: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  bankBalance: bigint;
  currencyName: string;
  currencyEmoji: string;
  accountEmoji: string;
  bannerUrl: string | null;
  textStyle: VirtualAccountTextStyle;
  exchangePlayerUnits: bigint | null;
  exchangeAccountUnits: bigint | null;
  accountPurpose: VirtualAccountPurpose;
  createdAt: Date;
  updatedAt: Date;
}

export interface VirtualAccountManager {
  id: string;
  accountId: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  userDiscordId: UserDiscordId;
  addedByDiscordId: UserDiscordId;
  createdAt: Date;
}

interface DbFinance extends Omit<VirtualAccountFinance, 'guildId' | 'nitradoConnId'> {
  guildId: string;
  nitradoConnId: string;
}
interface DbManager {
  id: string;
  accountId: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  addedByDiscordId: string;
  createdAt: Date;
}

const CURRENCY_MAX = 40;
const EMOJI_MAX = 100;
const BANNER_MAX = 512;
const REASON_MAX = 180;

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

function cleanPrintable(input: unknown, max: number, label: string): string {
  if (typeof input !== 'string') throw new Error(`${label} muss Text sein.`);
  const normalized = input.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${label} muss 1..${max} druckbare Zeichen enthalten.`);
  }
  return normalized;
}

export function normalizeCurrencyName(value: unknown): string {
  return cleanPrintable(value, CURRENCY_MAX, 'Waehrungsname');
}

export function normalizeCurrencyEmoji(value: unknown): string {
  return cleanPrintable(value, EMOJI_MAX, 'Waehrungs-Emoji');
}

export function normalizeAccountEmoji(value: unknown): string {
  return cleanPrintable(value, EMOJI_MAX, 'Konto-Emoji');
}

export function normalizeBannerUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error('Banner-URL muss Text oder null sein.');
  const clean = value.trim();
  if (clean.length > BANNER_MAX) throw new Error(`Banner-URL darf maximal ${BANNER_MAX} Zeichen enthalten.`);
  let parsed: URL;
  try { parsed = new URL(clean); } catch { throw new Error('Banner-URL ist ungueltig.'); }
  if (parsed.protocol !== 'https:') throw new Error('Banner/GIF muss ueber HTTPS erreichbar sein.');
  return parsed.toString();
}

export function normalizeTextStyle(value: unknown): VirtualAccountTextStyle {
  const style = typeof value === 'string' ? value : 'NORMAL';
  if (!(['NORMAL', 'BOLD', 'ITALIC', 'BOLD_ITALIC'] as const).includes(style as VirtualAccountTextStyle)) {
    throw new Error('Textstil ungueltig.');
  }
  return style as VirtualAccountTextStyle;
}

function toFinance(row: DbFinance): VirtualAccountFinance {
  return { ...row, guildId: row.guildId as GuildId, nitradoConnId: row.nitradoConnId as NitradoConnId };
}
function toManager(row: DbManager): VirtualAccountManager {
  return {
    ...row,
    guildId: row.guildId as GuildId,
    nitradoConnId: row.nitradoConnId as NitradoConnId,
    userDiscordId: row.userDiscordId as UserDiscordId,
    addedByDiscordId: row.addedByDiscordId as UserDiscordId,
  };
}

function normalizeExchange(playerUnits: unknown, accountUnits: unknown): { player: bigint | null; account: bigint | null } {
  const emptyPlayer = playerUnits === undefined || playerUnits === null || playerUnits === '';
  const emptyAccount = accountUnits === undefined || accountUnits === null || accountUnits === '';
  if (emptyPlayer && emptyAccount) return { player: null, account: null };
  if (emptyPlayer || emptyAccount) throw new Error('Wechselkurs benoetigt Spieler- und Konto-Einheiten.');
  let player: bigint;
  let account: bigint;
  try { player = BigInt(String(playerUnits)); account = BigInt(String(accountUnits)); }
  catch { throw new Error('Wechselkurs ist ungueltig.'); }
  if (player <= 0n || account <= 0n) throw new Error('Wechselkurs-Einheiten muessen groesser als 0 sein.');
  return { player, account };
}

async function readFinance(raw: VirtualAccountRawDb, guildId: GuildId, connId: NitradoConnId, accountId: string, lock = false): Promise<DbFinance | null> {
  const rows = await raw.$queryRawUnsafe<DbFinance[]>(
    'SELECT "accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "bannerUrl", "textStyle", "exchangePlayerUnits", "exchangeAccountUnits", "accountPurpose", "createdAt", "updatedAt" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1' + (lock ? ' FOR UPDATE' : ''),
    accountId, String(guildId), String(connId),
  );
  return rows[0] ?? null;
}

/** Lazy backfill fuer Konten, die nach der Migration durch Lotterie/Market entstehen. */
export async function ensureVirtualAccountFinance(guildId: GuildId, connId: NitradoConnId, accountId: string): Promise<VirtualAccountFinance> {
  await assertEconomyScopeReady(guildId, connId);
  const existing = await readFinance(rawDb(), guildId, connId, accountId);
  if (existing) return toFinance(existing);
  const account = await getVirtualAccountById(guildId, connId, accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const cfg = await getConfig(guildId, connId);
  const emoji = account.kind === 'LOTTERY_POT' ? '🎟️' : account.kind === 'MARKET_VENDOR' ? '🏴' : '🏦';
  await rawDb().$executeRawUnsafe(
    'INSERT INTO "EconomyVirtualAccountFinance" ("accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "accountPurpose", "createdAt", "updatedAt") VALUES ($1,$2,$3,0,$4,$5,$6,\'GENERAL\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO NOTHING',
    accountId, String(guildId), String(connId), cfg.currencyName, cfg.emoji, emoji,
  );
  const created = await readFinance(rawDb(), guildId, connId, accountId);
  if (!created) throw new Error('Konto-Finanzprofil konnte nicht erzeugt werden.');
  return toFinance(created);
}

export async function updateVirtualAccountFinance(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  currencyName: unknown;
  currencyEmoji: unknown;
  accountEmoji: unknown;
  bannerUrl?: unknown;
  textStyle?: unknown;
  exchangePlayerUnits?: unknown;
  exchangeAccountUnits?: unknown;
}): Promise<VirtualAccountFinance> {
  await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  const currencyName = normalizeCurrencyName(args.currencyName);
  const currencyEmoji = normalizeCurrencyEmoji(args.currencyEmoji);
  const accountEmoji = normalizeAccountEmoji(args.accountEmoji);
  const bannerUrl = normalizeBannerUrl(args.bannerUrl);
  const textStyle = normalizeTextStyle(args.textStyle);
  const exchange = normalizeExchange(args.exchangePlayerUnits, args.exchangeAccountUnits);
  const rows = await rawDb().$queryRawUnsafe<DbFinance[]>(
    'UPDATE "EconomyVirtualAccountFinance" SET "currencyName"=$4, "currencyEmoji"=$5, "accountEmoji"=$6, "bannerUrl"=$7, "textStyle"=$8, "exchangePlayerUnits"=$9, "exchangeAccountUnits"=$10, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 RETURNING "accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "bannerUrl", "textStyle", "exchangePlayerUnits", "exchangeAccountUnits", "accountPurpose", "createdAt", "updatedAt"',
    args.accountId, String(args.guildId), String(args.nitradoConnId), currencyName, currencyEmoji, accountEmoji,
    bannerUrl, textStyle, exchange.player, exchange.account,
  );
  if (!rows[0]) throw new Error('Konto-Finanzprofil konnte nicht aktualisiert werden.');
  return toFinance(rows[0]);
}

export async function listVirtualAccountManagers(guildId: GuildId, connId: NitradoConnId, accountId?: string): Promise<VirtualAccountManager[]> {
  await assertEconomyScopeReady(guildId, connId);
  const rows = accountId
    ? await rawDb().$queryRawUnsafe<DbManager[]>('SELECT * FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountId"=$3 ORDER BY "createdAt"', String(guildId), String(connId), accountId)
    : await rawDb().$queryRawUnsafe<DbManager[]>('SELECT * FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 ORDER BY "createdAt"', String(guildId), String(connId));
  return rows.map(toManager);
}

export async function replaceVirtualAccountManagers(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  userDiscordIds: UserDiscordId[];
  addedByDiscordId: UserDiscordId;
}): Promise<VirtualAccountManager[]> {
  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
  const ids = [...new Set(args.userDiscordIds.map(String))];
  if (ids.length > 25) throw new Error('Maximal 25 Kontoverwalter pro Konto.');
  await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    await raw.$executeRawUnsafe('DELETE FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountId"=$3', String(args.guildId), String(args.nitradoConnId), args.accountId);
    for (const id of ids) {
      if (!/^\d{17,20}$/.test(id)) throw new Error('Ungueltige Discord-ID in Kontoverwaltern.');
      await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualAccountManager" ("id", "accountId", "guildId", "nitradoConnId", "userDiscordId", "addedByDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)',
        randomUUID(), args.accountId, String(args.guildId), String(args.nitradoConnId), id, String(args.addedByDiscordId),
      );
    }
  });
  return listVirtualAccountManagers(args.guildId, args.nitradoConnId, args.accountId);
}

export async function userManagesVirtualAccount(guildId: GuildId, connId: NitradoConnId, accountId: string, userDiscordId: UserDiscordId): Promise<boolean> {
  const rows = await rawDb().$queryRawUnsafe<Array<{ ok: number }>>(
    'SELECT 1 AS ok FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountId"=$3 AND "userDiscordId"=$4 LIMIT 1',
    String(guildId), String(connId), accountId, String(userDiscordId),
  );
  return Boolean(rows[0]);
}

export async function listManagedVirtualAccounts(guildId: GuildId, connId: NitradoConnId, userDiscordId: UserDiscordId): Promise<VirtualAccountRow[]> {
  await assertEconomyScopeReady(guildId, connId);
  const rows = await rawDb().$queryRawUnsafe<Array<{ accountId: string }>>(
    'SELECT "accountId" FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 ORDER BY "createdAt"',
    String(guildId), String(connId), String(userDiscordId),
  );
  const accounts: VirtualAccountRow[] = [];
  for (const row of rows) {
    const account = await getVirtualAccountById(guildId, connId, row.accountId);
    if (account && account.status !== 'ARCHIVED') accounts.push(account);
  }
  return accounts;
}

export async function ensureBankTreasury(args: { guildId: GuildId; nitradoConnId: NitradoConnId; createdByDiscordId: UserDiscordId }): Promise<{ account: VirtualAccountRow; finance: VirtualAccountFinance }> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const existing = await rawDb().$queryRawUnsafe<Array<{ accountId: string }>>(
    'SELECT "accountId" FROM "EconomyVirtualAccountFinance" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountPurpose"=\'BANK_TREASURY\' LIMIT 1',
    String(args.guildId), String(args.nitradoConnId),
  );
  let account = existing[0] ? await getVirtualAccountById(args.guildId, args.nitradoConnId, existing[0].accountId) : null;
  if (!account) {
    account = await createVirtualAccount({
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      name: 'Serverbank',
      kind: 'CUSTOM',
      acceptUserTransfers: true,
      createdByDiscordId: args.createdByDiscordId,
    });
    await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, account.id);
    await rawDb().$executeRawUnsafe(
      'UPDATE "EconomyVirtualAccountFinance" SET "accountPurpose"=\'BANK_TREASURY\', "accountEmoji"=\'🏦\', "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1',
      account.id,
    );
  }
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, account.id);
  return { account, finance };
}

function currenciesMatch(serverName: string, finance: VirtualAccountFinance): boolean {
  return serverName.trim().toLocaleLowerCase('de-DE') === finance.currencyName.trim().toLocaleLowerCase('de-DE');
}

function convertPlayerToAccount(amount: bigint, serverName: string, finance: VirtualAccountFinance): bigint {
  if (currenciesMatch(serverName, finance)) return amount;
  if (!finance.exchangePlayerUnits || !finance.exchangeAccountUnits) {
    throw new Error(`Keine Wechselrate von ${serverName} zu ${finance.currencyName} konfiguriert.`);
  }
  const numerator = amount * finance.exchangeAccountUnits;
  if (numerator % finance.exchangePlayerUnits !== 0n) throw new Error('Betrag kann mit dem konfigurierten Wechselkurs nicht ohne Rundungsverlust umgerechnet werden.');
  return numerator / finance.exchangePlayerUnits;
}

function convertAccountToPlayer(amount: bigint, serverName: string, finance: VirtualAccountFinance): bigint {
  if (currenciesMatch(serverName, finance)) return amount;
  if (!finance.exchangePlayerUnits || !finance.exchangeAccountUnits) {
    throw new Error(`Keine Wechselrate von ${finance.currencyName} zu ${serverName} konfiguriert.`);
  }
  const numerator = amount * finance.exchangePlayerUnits;
  if (numerator % finance.exchangeAccountUnits !== 0n) throw new Error('Betrag kann mit dem konfigurierten Wechselkurs nicht ohne Rundungsverlust umgerechnet werden.');
  return numerator / finance.exchangeAccountUnits;
}

function operationKey(prefix: string, guildId: GuildId, connId: NitradoConnId, external: string): string {
  const clean = external.normalize('NFKC').trim();
  if (!clean || clean.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(clean)) throw new Error('Idempotency-Key ungueltig.');
  return `${prefix}:${guildId}:${connId}:${clean}`;
}

async function ensureUser(raw: VirtualAccountRawDb, guildId: GuildId, connId: NitradoConnId, userId: UserDiscordId) {
  await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyAccount" ("id", "guildId", "nitradoConnId", "userDiscordId", "walletBalance", "bankBalance", "lifetimeEarned", "lifetimeSpent", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,0,0,0,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("guildId", "nitradoConnId", "userDiscordId") DO NOTHING',
    randomUUID(), String(guildId), String(connId), String(userId),
  );
}

async function writePlayerLedger(raw: VirtualAccountRawDb, args: {
  key: string; guildId: GuildId; connId: NitradoConnId; userId: UserDiscordId;
  walletDelta: bigint; bankDelta: bigint; reason: string; actorDiscordId: UserDiscordId | null; sourceRef: string;
}) {
  const delta = args.walletDelta + args.bankDelta;
  const txType = args.walletDelta < 0n || args.bankDelta < 0n ? 'PAY' : 'TRANSFER';
  await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyTransaction" ("id", "guildId", "nitradoConnId", "userDiscordId", "delta", "type", "reason", "actorDiscordId", "counterpartDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,NULL,CURRENT_TIMESTAMP)',
    randomUUID(), String(args.guildId), String(args.connId), String(args.userId), delta, txType, args.reason.slice(0, 180), args.actorDiscordId ? String(args.actorDiscordId) : null,
  );
  const changed = await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyLedgerEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "userDiscordId", "walletDelta", "bankDelta", "type", "reason", "buckets", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"EconomyTxType",$9,0,$10,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
    randomUUID(), `${args.key}:user`, String(args.guildId), String(args.connId), String(args.userId), args.walletDelta, args.bankDelta, txType, args.reason.slice(0, 180), args.sourceRef,
  );
  if (changed !== 1) throw new Error('User-Ledger-Idempotenzkonflikt.');
}

export async function depositUserIntoVirtualAccount(args: {
  idempotencyKey: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  userDiscordId: UserDiscordId;
  sourcePocket: EconomyPocket;
  playerAmount: bigint;
  reason?: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow; finance: VirtualAccountFinance; playerDebited: bigint; accountCredited: bigint }> {
  if (args.playerAmount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
  if (args.sourcePocket !== 'WALLET' && args.sourcePocket !== 'BANK') throw new Error('Quellkonto ungueltig.');
  const cfg = await getConfig(args.guildId, args.nitradoConnId);
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  const accountAmount = convertPlayerToAccount(args.playerAmount, cfg.currencyName, finance);
  if (accountAmount <= 0n) throw new Error('Umgerechneter Betrag muss groesser als 0 sein.');
  const key = operationKey('virtual-deposit', args.guildId, args.nitradoConnId, args.idempotencyKey);
  const reason = (args.reason?.trim() || 'Einzahlung auf virtuelles Konto').slice(0, REASON_MAX);

  const result = await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const accounts = await raw.$queryRawUnsafe<Array<{ id: string; kind: string; name: string; balance: bigint; status: string; acceptUserTransfers: boolean }>>(
      'SELECT "id", "kind"::text AS kind, "name", "balance", "status"::text AS status, "acceptUserTransfers" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.accountId, String(args.guildId), String(args.nitradoConnId),
    );
    const account = accounts[0];
    if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
    if (account.status !== 'ACTIVE') throw new Error('Virtuelles Konto ist nicht aktiv.');
    if (!account.acceptUserTransfers) throw new Error('Dieses Konto nimmt keine direkten Einzahlungen an.');
    const currentFinance = await readFinance(raw, args.guildId, args.nitradoConnId, args.accountId, true);
    if (!currentFinance) throw new Error('Konto-Finanzprofil fehlt.');

    const replay = await raw.$queryRawUnsafe<Array<{ delta: bigint; sourcePocket: string | null; userDiscordId: string | null }>>(
      'SELECT "delta", "sourcePocket", "userDiscordId" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1', key,
    );
    if (replay[0]) {
      if (replay[0].delta !== accountAmount || replay[0].sourcePocket !== args.sourcePocket || replay[0].userDiscordId !== String(args.userDiscordId)) {
        throw new Error('Idempotency-Key wurde mit anderen Einzahlungsdaten wiederverwendet.');
      }
      return { booked: false };
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
      args.accountId, String(args.guildId), String(args.nitradoConnId), accountAmount,
    );
    if (credited !== 1) throw new Error('Virtuelles Konto konnte nicht gutgeschrieben werden.');

    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'USER_DEPOSIT\',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)',
      randomUUID(), key, String(args.guildId), String(args.nitradoConnId), args.accountId, accountAmount, args.sourcePocket,
      String(args.userDiscordId), String(args.userDiscordId), reason, `virtual-account:${args.accountId}`,
    );
    await writePlayerLedger(raw, {
      key, guildId: args.guildId, connId: args.nitradoConnId, userId: args.userDiscordId,
      walletDelta: args.sourcePocket === 'WALLET' ? -args.playerAmount : 0n,
      bankDelta: args.sourcePocket === 'BANK' ? -args.playerAmount : 0n,
      reason: `${reason} -> ${account.name}`, actorDiscordId: args.userDiscordId, sourceRef: `virtual-account:${args.accountId}`,
    });
    return { booked: true };
  });

  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  const latestFinance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto konnte nach Einzahlung nicht gelesen werden.');
  return { ...result, account, finance: latestFinance, playerDebited: args.playerAmount, accountCredited: accountAmount };
}

export async function transferVirtualPocket(args: {
  idempotencyKey: string; guildId: GuildId; nitradoConnId: NitradoConnId; accountId: string;
  actorDiscordId: UserDiscordId; from: EconomyPocket; to: EconomyPocket; amount: bigint; reason?: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow; finance: VirtualAccountFinance }> {
  if (args.from === args.to) throw new Error('Quell- und Ziel-Pocket muessen verschieden sein.');
  if (args.amount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
  const key = operationKey('virtual-pocket', args.guildId, args.nitradoConnId, args.idempotencyKey);
  const reason = (args.reason?.trim() || `${args.from} -> ${args.to}`).slice(0, REASON_MAX);
  await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  const booked = await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const account = await raw.$queryRawUnsafe<Array<{ balance: bigint; status: string }>>(
      'SELECT "balance", "status"::text AS status FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE', args.accountId, String(args.guildId), String(args.nitradoConnId),
    );
    if (!account[0] || account[0].status === 'ARCHIVED') throw new Error('Virtuelles Konto ist nicht verfuegbar.');
    const finance = await readFinance(raw, args.guildId, args.nitradoConnId, args.accountId, true);
    if (!finance) throw new Error('Konto-Finanzprofil fehlt.');
    const replay = await raw.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1', key);
    if (replay[0]) return false;
    if (args.from === 'WALLET') {
      const debit = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccount" SET "balance"="balance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "balance">=$4', args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount);
      if (debit !== 1) throw new Error('Virtuelles Wallet hat zu wenig Guthaben.');
      const credit = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"="bankBalance"+$2, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1', args.accountId, args.amount);
      if (credit !== 1) throw new Error('Virtuelle Bank konnte nicht aktualisiert werden.');
    } else {
      const debit = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"="bankBalance"-$2, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "bankBalance">=$2', args.accountId, args.amount);
      if (debit !== 1) throw new Error('Virtuelle Bank hat zu wenig Guthaben.');
      const credit = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccount" SET "balance"="balance"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3', args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount);
      if (credit !== 1) throw new Error('Virtuelles Wallet konnte nicht aktualisiert werden.');
    }
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,0,\'POCKET_TRANSFER\',$6,$7,NULL,$8,$9,CURRENT_TIMESTAMP)',
      randomUUID(), key, String(args.guildId), String(args.nitradoConnId), args.accountId, args.from, String(args.actorDiscordId), reason, `${args.from}->${args.to}`,
    );
    return true;
  });
  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto fehlt nach Pocket-Transfer.');
  return { booked, account, finance };
}

export async function removeVirtualAccountAmount(args: {
  idempotencyKey: string; guildId: GuildId; nitradoConnId: NitradoConnId; accountId: string;
  actorDiscordId: UserDiscordId; pocket: EconomyPocket; amount: bigint; reason: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow; finance: VirtualAccountFinance }> {
  if (args.amount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
  const reason = args.reason.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (reason.length < 3 || reason.length > REASON_MAX) throw new Error('Remove-Grund muss 3..180 Zeichen enthalten.');
  const key = operationKey('virtual-remove', args.guildId, args.nitradoConnId, args.idempotencyKey);
  await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  const booked = await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const replay = await raw.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1', key);
    if (replay[0]) return false;
    if (args.pocket === 'WALLET') {
      const changed = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccount" SET "balance"="balance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"<>\'ARCHIVED\'::"EconomyVirtualAccountStatus" AND "balance">=$4', args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount);
      if (changed !== 1) throw new Error('Virtuelles Wallet hat zu wenig Guthaben oder ist archiviert.');
    } else {
      // Hard-Delete und alle anderen gekoppelten Geldpfade locken zuerst das
      // Basiskonto. Das BANK-Remove uebernimmt dieselbe Reihenfolge, bevor das
      // Finance-UPDATE dessen Row-Lock nimmt; damit entsteht kein Finance->Account
      // Lock-Zyklus gegen deleteUnusedVirtualAccount (Account->Finance).
      await raw.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT "id" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.accountId, String(args.guildId), String(args.nitradoConnId),
      );
      const changed = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccountFinance" f SET "bankBalance"=f."bankBalance"-$4, "updatedAt"=CURRENT_TIMESTAMP FROM "EconomyVirtualAccount" a WHERE f."accountId"=$1 AND f."guildId"=$2 AND f."nitradoConnId"=$3 AND a."id"=f."accountId" AND a."status"<>\'ARCHIVED\'::"EconomyVirtualAccountStatus" AND f."bankBalance">=$4', args.accountId, String(args.guildId), String(args.nitradoConnId), args.amount);
      if (changed !== 1) throw new Error('Virtuelle Bank hat zu wenig Guthaben oder ist archiviert.');
    }
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'MANAGER_REMOVE\',$7,$8,NULL,$9,$10,CURRENT_TIMESTAMP)',
      randomUUID(), key, String(args.guildId), String(args.nitradoConnId), args.accountId, -args.amount, args.pocket, String(args.actorDiscordId), reason, `virtual-account:${args.accountId}`,
    );
    return true;
  });
  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto fehlt nach Remove.');
  return { booked, account, finance };
}

export async function payoutVirtualAccountToUser(args: {
  idempotencyKey: string; guildId: GuildId; nitradoConnId: NitradoConnId; accountId: string;
  actorDiscordId: UserDiscordId; toUserDiscordId: UserDiscordId; sourcePocket: EconomyPocket; targetPocket: EconomyPocket;
  accountAmount: bigint; reason: string;
}): Promise<{ booked: boolean; account: VirtualAccountRow; finance: VirtualAccountFinance; accountDebited: bigint; playerCredited: bigint }> {
  if (args.accountAmount <= 0n) throw new Error('Betrag muss groesser als 0 sein.');
  const reason = args.reason.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (reason.length < 3 || reason.length > REASON_MAX) throw new Error('Auszahlungsgrund muss 3..180 Zeichen enthalten.');
  const cfg = await getConfig(args.guildId, args.nitradoConnId);
  const finance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  const playerAmount = convertAccountToPlayer(args.accountAmount, cfg.currencyName, finance);
  const key = operationKey('virtual-payout', args.guildId, args.nitradoConnId, args.idempotencyKey);
  const booked = await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    const accounts = await raw.$queryRawUnsafe<Array<{ status: string; kind: string; name: string }>>('SELECT "status"::text AS status, "kind"::text AS kind, "name" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE', args.accountId, String(args.guildId), String(args.nitradoConnId));
    const account = accounts[0];
    if (!account || account.status === 'ARCHIVED') throw new Error('Virtuelles Konto ist nicht verfuegbar.');
    if (account.kind === 'LOTTERY_POT') throw new Error('Lotterie-Systemkonten duerfen nicht ueber die generische Manager-Auszahlung manipuliert werden.');
    const replay = await raw.$queryRawUnsafe<Array<{ id: string }>>('SELECT "id" FROM "EconomyVirtualAccountEntry" WHERE "idempotencyKey"=$1 LIMIT 1', key);
    if (replay[0]) return false;
    if (args.sourcePocket === 'WALLET') {
      const changed = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccount" SET "balance"="balance"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "balance">=$4', args.accountId, String(args.guildId), String(args.nitradoConnId), args.accountAmount);
      if (changed !== 1) throw new Error('Virtuelles Wallet hat zu wenig Guthaben.');
    } else {
      const changed = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccountFinance" SET "bankBalance"="bankBalance"-$2, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "bankBalance">=$2', args.accountId, args.accountAmount);
      if (changed !== 1) throw new Error('Virtuelle Bank hat zu wenig Guthaben.');
    }
    await ensureUser(raw, args.guildId, args.nitradoConnId, args.toUserDiscordId);
    const credited = args.targetPocket === 'WALLET'
      ? await raw.$executeRawUnsafe(
        'UPDATE "EconomyAccount" SET "walletBalance"="walletBalance"+$4, "lifetimeEarned"="lifetimeEarned"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3',
        String(args.guildId), String(args.nitradoConnId), String(args.toUserDiscordId), playerAmount,
      )
      : await raw.$executeRawUnsafe(
        'UPDATE "EconomyAccount" SET "bankBalance"="bankBalance"+$4, "lifetimeEarned"="lifetimeEarned"+$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3',
        String(args.guildId), String(args.nitradoConnId), String(args.toUserDiscordId), playerAmount,
      );
    if (credited !== 1) throw new Error('Spielerkonto konnte nicht gutgeschrieben werden.');
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id", "idempotencyKey", "guildId", "nitradoConnId", "virtualAccountId", "delta", "entryType", "sourcePocket", "actorDiscordId", "userDiscordId", "reason", "sourceRef", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'MANAGER_PAYOUT\',$7,$8,$9,$10,$11,CURRENT_TIMESTAMP)',
      randomUUID(), key, String(args.guildId), String(args.nitradoConnId), args.accountId, -args.accountAmount, args.sourcePocket, String(args.actorDiscordId), String(args.toUserDiscordId), reason, `virtual-account:${args.accountId}`,
    );
    await writePlayerLedger(raw, {
      key, guildId: args.guildId, connId: args.nitradoConnId, userId: args.toUserDiscordId,
      walletDelta: args.targetPocket === 'WALLET' ? playerAmount : 0n,
      bankDelta: args.targetPocket === 'BANK' ? playerAmount : 0n,
      reason: `${reason} <- ${account.name}`, actorDiscordId: args.actorDiscordId, sourceRef: `virtual-account:${args.accountId}`,
    });
    return true;
  });
  const account = await getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId);
  const latestFinance = await ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId);
  if (!account) throw new Error('Virtuelles Konto fehlt nach Auszahlung.');
  return { booked, account, finance: latestFinance, accountDebited: args.accountAmount, playerCredited: playerAmount };
}