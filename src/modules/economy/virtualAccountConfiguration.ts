import { randomUUID } from 'node:crypto';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import {
  getVirtualAccountById,
  normalizeVirtualAccountName,
  type VirtualAccountRawDb,
  type VirtualAccountRow,
} from './virtualAccounts';
import {
  normalizeVirtualAccountChannels,
  normalizeVirtualAccountDescription,
} from './virtualAccountMetadata';
import {
  ensureVirtualAccountFinance,
  normalizeAccountEmoji,
  normalizeBannerUrl,
  normalizeCurrencyEmoji,
  normalizeCurrencyName,
  normalizeTextStyle,
  type VirtualAccountFinance,
} from './virtualAccountFinance';
import { getConfig } from './repository';
import { assertEconomyScopeReady } from './scopeMigration';

interface PreparedConfiguration {
  description: string | null;
  channelId: string | null;
  archiveChannelId: string | null;
  currencyName: string;
  currencyEmoji: string;
  accountEmoji: string;
  bannerUrl: string | null;
  textStyle: ReturnType<typeof normalizeTextStyle>;
  exchangePlayerUnits: bigint | null;
  exchangeAccountUnits: bigint | null;
  acceptUserTransfers: boolean;
  managers: UserDiscordId[];
}

interface LockedAccountConfigurationRow {
  balance: bigint;
  status: string;
  acceptUserTransfers: boolean;
}

interface LockedFinanceConfigurationRow {
  bankBalance: bigint;
  currencyName: string;
  currencyEmoji: string;
  accountEmoji: string;
  bannerUrl: string | null;
  textStyle: string;
  exchangePlayerUnits: bigint | null;
  exchangeAccountUnits: bigint | null;
}

export interface ConfiguredVirtualAccountResult {
  account: VirtualAccountRow;
  finance: VirtualAccountFinance;
}

function rawDb(client: unknown = prisma): VirtualAccountRawDb {
  return client as VirtualAccountRawDb;
}

function normalizeExchange(playerRaw: unknown, accountRaw: unknown): { player: bigint | null; account: bigint | null } {
  const playerEmpty = playerRaw === undefined || playerRaw === null || playerRaw === '';
  const accountEmpty = accountRaw === undefined || accountRaw === null || accountRaw === '';
  if (playerEmpty && accountEmpty) return { player: null, account: null };
  if (playerEmpty || accountEmpty) throw new Error('Wechselkurs benoetigt Spieler- und Konto-Einheiten.');
  let player: bigint;
  let account: bigint;
  try {
    player = BigInt(String(playerRaw));
    account = BigInt(String(accountRaw));
  } catch {
    throw new Error('Wechselkurs ist ungueltig.');
  }
  if (player <= 0n || account <= 0n) throw new Error('Wechselkurs-Einheiten muessen groesser als 0 sein.');
  return { player, account };
}

function prepare(args: {
  description?: unknown;
  channelId?: unknown;
  archiveChannelId?: unknown;
  currencyName: unknown;
  currencyEmoji: unknown;
  accountEmoji: unknown;
  bannerUrl?: unknown;
  textStyle?: unknown;
  exchangePlayerUnits?: unknown;
  exchangeAccountUnits?: unknown;
  acceptUserTransfers: unknown;
  managers: UserDiscordId[];
}): PreparedConfiguration {
  if (typeof args.acceptUserTransfers !== 'boolean') throw new Error('acceptUserTransfers muss boolean sein.');
  const managers = [...new Map(args.managers.map(id => [String(id), id] as const)).values()];
  if (managers.length > 25) throw new Error('Maximal 25 Kontoverwalter pro Konto.');
  for (const id of managers) {
    if (!/^\d{17,20}$/.test(String(id))) throw new Error('Ungueltige Discord-ID in Kontoverwaltern.');
  }
  const exchange = normalizeExchange(args.exchangePlayerUnits, args.exchangeAccountUnits);
  const channels = normalizeVirtualAccountChannels(args.channelId, args.archiveChannelId);
  return {
    description: normalizeVirtualAccountDescription(args.description),
    channelId: channels.channelId,
    archiveChannelId: channels.archiveChannelId,
    currencyName: normalizeCurrencyName(args.currencyName),
    currencyEmoji: normalizeCurrencyEmoji(args.currencyEmoji),
    accountEmoji: normalizeAccountEmoji(args.accountEmoji),
    bannerUrl: normalizeBannerUrl(args.bannerUrl),
    textStyle: normalizeTextStyle(args.textStyle),
    exchangePlayerUnits: exchange.player,
    exchangeAccountUnits: exchange.account,
    acceptUserTransfers: args.acceptUserTransfers,
    managers,
  };
}

async function insertManagers(raw: VirtualAccountRawDb, args: {
  accountId: string;
  guildId: GuildId;
  connId: NitradoConnId;
  managers: UserDiscordId[];
  actor: UserDiscordId;
}): Promise<void> {
  for (const userId of args.managers) {
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountManager" ("id", "accountId", "guildId", "nitradoConnId", "userDiscordId", "addedByDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP)',
      randomUUID(),
      args.accountId,
      String(args.guildId),
      String(args.connId),
      String(userId),
      String(args.actor),
    );
  }
}

function uniqueConflict(error: unknown): boolean {
  const candidate = typeof error === 'object' && error !== null
    ? error as { code?: string; meta?: { code?: string } }
    : {};
  return candidate.code === '23505' || candidate.code === 'P2002' || candidate.meta?.code === '23505';
}

function currencyKey(value: string): string {
  return value.normalize('NFKC').trim().toLocaleLowerCase('de-DE');
}

function exchangeChanged(current: LockedFinanceConfigurationRow, prepared: PreparedConfiguration): boolean {
  return current.exchangePlayerUnits !== prepared.exchangePlayerUnits
    || current.exchangeAccountUnits !== prepared.exchangeAccountUnits;
}

export async function createConfiguredCustomVirtualAccount(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  name: string;
  description?: unknown;
  channelId?: unknown;
  archiveChannelId?: unknown;
  expiresAt?: Date | null;
  currencyName?: unknown;
  currencyEmoji?: unknown;
  accountEmoji?: unknown;
  bannerUrl?: unknown;
  textStyle?: unknown;
  exchangePlayerUnits?: unknown;
  exchangeAccountUnits?: unknown;
  acceptUserTransfers?: unknown;
  managers: UserDiscordId[];
  createdByDiscordId: UserDiscordId;
}): Promise<ConfiguredVirtualAccountResult> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const { name, nameKey } = normalizeVirtualAccountName(args.name);
  if (args.expiresAt && args.expiresAt.getTime() <= Date.now()) throw new Error('Ablaufzeit muss in der Zukunft liegen.');
  const cfg = await getConfig(args.guildId, args.nitradoConnId);
  const prepared = prepare({
    description: args.description,
    channelId: args.channelId,
    archiveChannelId: args.archiveChannelId,
    currencyName: args.currencyName ?? cfg.currencyName,
    currencyEmoji: args.currencyEmoji ?? cfg.emoji,
    accountEmoji: args.accountEmoji ?? '🏦',
    bannerUrl: args.bannerUrl,
    textStyle: args.textStyle ?? 'NORMAL',
    exchangePlayerUnits: args.exchangePlayerUnits,
    exchangeAccountUnits: args.exchangeAccountUnits,
    acceptUserTransfers: args.acceptUserTransfers === undefined ? true : args.acceptUserTransfers,
    managers: args.managers,
  });
  // Ein unverwaltbares Konto waere im rollenlosen Discord-Panel unsichtbar.
  // Ohne explizite Auswahl bleibt deshalb mindestens der Ersteller berechtigt.
  const managers = prepared.managers.length > 0 ? prepared.managers : [args.createdByDiscordId];
  const accountId = randomUUID();

  try {
    await prisma.$transaction(async tx => {
      const raw = rawDb(tx);
      const accountChanged = await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualAccount" ("id", "guildId", "nitradoConnId", "kind", "name", "nameKey", "balance", "status", "acceptUserTransfers", "expiresAt", "archivedAt", "archivedByDiscordId", "createdByDiscordId", "createdAt", "updatedAt") VALUES ($1,$2,$3,\'CUSTOM\'::"EconomyVirtualAccountKind",$4,$5,0,\'ACTIVE\'::"EconomyVirtualAccountStatus",$6,$7,NULL,NULL,$8,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        accountId,
        String(args.guildId),
        String(args.nitradoConnId),
        name,
        nameKey,
        prepared.acceptUserTransfers,
        args.expiresAt ?? null,
        String(args.createdByDiscordId),
      );
      if (accountChanged !== 1) throw new Error('Virtuelles Konto konnte nicht erstellt werden.');

      const metadataChanged = await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualAccountMetadata" ("accountId", "guildId", "nitradoConnId", "description", "channelId", "archiveChannelId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        accountId,
        String(args.guildId),
        String(args.nitradoConnId),
        prepared.description,
        prepared.channelId,
        prepared.archiveChannelId,
      );
      if (metadataChanged !== 1) throw new Error('Kontometadaten konnten nicht erstellt werden.');

      const financeChanged = await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualAccountFinance" ("accountId", "guildId", "nitradoConnId", "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "bannerUrl", "textStyle", "exchangePlayerUnits", "exchangeAccountUnits", "accountPurpose", "createdAt", "updatedAt") VALUES ($1,$2,$3,0,$4,$5,$6,$7,$8,$9,$10,\'GENERAL\',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        accountId,
        String(args.guildId),
        String(args.nitradoConnId),
        prepared.currencyName,
        prepared.currencyEmoji,
        prepared.accountEmoji,
        prepared.bannerUrl,
        prepared.textStyle,
        prepared.exchangePlayerUnits,
        prepared.exchangeAccountUnits,
      );
      if (financeChanged !== 1) throw new Error('Konto-Finanzprofil konnte nicht erstellt werden.');
      await insertManagers(raw, {
        accountId,
        guildId: args.guildId,
        connId: args.nitradoConnId,
        managers,
        actor: args.createdByDiscordId,
      });
    });
  } catch (error) {
    if (uniqueConflict(error)) throw new Error('Ein virtuelles Konto mit diesem Namen existiert bereits auf diesem Gameserver.');
    throw error;
  }

  const [account, finance] = await Promise.all([
    getVirtualAccountById(args.guildId, args.nitradoConnId, accountId),
    ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, accountId),
  ]);
  if (!account) throw new Error('Virtuelles Konto wurde angelegt, konnte aber nicht konsistent gelesen werden.');
  return { account, finance };
}

export async function updateConfiguredVirtualAccount(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  accountId: string;
  description?: unknown;
  channelId?: unknown;
  archiveChannelId?: unknown;
  currencyName?: unknown;
  currencyEmoji?: unknown;
  accountEmoji?: unknown;
  bannerUrl?: unknown;
  textStyle?: unknown;
  exchangePlayerUnits?: unknown;
  exchangeAccountUnits?: unknown;
  acceptUserTransfers?: unknown;
  managers: UserDiscordId[];
  updatedByDiscordId: UserDiscordId;
}): Promise<ConfiguredVirtualAccountResult> {
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);

  await prisma.$transaction(async tx => {
    const raw = rawDb(tx);
    // Gleiche Lock-Reihenfolge wie Geldbewegungen: zuerst Basis-Konto, danach
    // Finanzprofil. Dadurch kann eine Konfigurationsaenderung weder zwischen
    // Debit/Credit geraten noch einen bereits finanzierten Saldo umetikettieren.
    const accountRows = await raw.$queryRawUnsafe<LockedAccountConfigurationRow[]>(
      'SELECT "balance", "status"::text AS status, "acceptUserTransfers" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const account = accountRows[0];
    if (!account) throw new Error('Virtuelles Konto nicht gefunden.');
    if (account.status === 'ARCHIVED') throw new Error('Archivierte Konten koennen nicht mehr konfiguriert werden.');

    const financeRows = await raw.$queryRawUnsafe<LockedFinanceConfigurationRow[]>(
      'SELECT "bankBalance", "currencyName", "currencyEmoji", "accountEmoji", "bannerUrl", "textStyle", "exchangePlayerUnits", "exchangeAccountUnits" FROM "EconomyVirtualAccountFinance" WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
    );
    const currentFinance = financeRows[0];
    if (!currentFinance) throw new Error('Konto-Finanzprofil fehlt oder gehoert zu einem anderen Scope.');

    const prepared = prepare({
      description: args.description,
      channelId: args.channelId,
      archiveChannelId: args.archiveChannelId,
      currencyName: args.currencyName ?? currentFinance.currencyName,
      currencyEmoji: args.currencyEmoji ?? currentFinance.currencyEmoji,
      accountEmoji: args.accountEmoji ?? currentFinance.accountEmoji,
      bannerUrl: args.bannerUrl === undefined ? currentFinance.bannerUrl : args.bannerUrl,
      textStyle: args.textStyle ?? currentFinance.textStyle,
      exchangePlayerUnits: args.exchangePlayerUnits === undefined ? currentFinance.exchangePlayerUnits : args.exchangePlayerUnits,
      exchangeAccountUnits: args.exchangeAccountUnits === undefined ? currentFinance.exchangeAccountUnits : args.exchangeAccountUnits,
      acceptUserTransfers: args.acceptUserTransfers === undefined ? account.acceptUserTransfers : args.acceptUserTransfers,
      managers: args.managers,
    });
    // Auch nach einer Bearbeitung darf ein aktives CUSTOM-Konto nicht aus dem
    // einzigen rollenlosen Verwaltungsweg ausgesperrt werden.
    const managers = prepared.managers.length > 0 ? prepared.managers : [args.updatedByDiscordId];

    const funded = account.balance + currentFinance.bankBalance > 0n;
    const currencyChanged = currencyKey(prepared.currencyName) !== currencyKey(currentFinance.currencyName);
    if (funded && (currencyChanged || exchangeChanged(currentFinance, prepared))) {
      throw new Error('Waehrung oder Wechselkurs kann bei vorhandenem Wallet- oder Bankguthaben nicht geaendert werden. Zuerst beide Pockets auf 0 setzen.');
    }

    const accountChanged = await raw.$executeRawUnsafe(
      'UPDATE "EconomyVirtualAccount" SET "acceptUserTransfers"=$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"<>\'ARCHIVED\'::"EconomyVirtualAccountStatus"',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
      prepared.acceptUserTransfers,
    );
    if (accountChanged !== 1) throw new Error('Virtuelles Konto wurde parallel archiviert oder entfernt.');

    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountMetadata" ("accountId", "guildId", "nitradoConnId", "description", "channelId", "archiveChannelId", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("accountId") DO UPDATE SET "description"=EXCLUDED."description", "channelId"=EXCLUDED."channelId", "archiveChannelId"=EXCLUDED."archiveChannelId", "updatedAt"=CURRENT_TIMESTAMP',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
      prepared.description,
      prepared.channelId,
      prepared.archiveChannelId,
    );
    const financeChanged = await raw.$executeRawUnsafe(
      'UPDATE "EconomyVirtualAccountFinance" SET "currencyName"=$4, "currencyEmoji"=$5, "accountEmoji"=$6, "bannerUrl"=$7, "textStyle"=$8, "exchangePlayerUnits"=$9, "exchangeAccountUnits"=$10, "updatedAt"=CURRENT_TIMESTAMP WHERE "accountId"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
      args.accountId,
      String(args.guildId),
      String(args.nitradoConnId),
      prepared.currencyName,
      prepared.currencyEmoji,
      prepared.accountEmoji,
      prepared.bannerUrl,
      prepared.textStyle,
      prepared.exchangePlayerUnits,
      prepared.exchangeAccountUnits,
    );
    if (financeChanged !== 1) throw new Error('Konto-Finanzprofil fehlt oder gehoert zu einem anderen Scope.');
    await raw.$executeRawUnsafe(
      'DELETE FROM "EconomyVirtualAccountManager" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "accountId"=$3',
      String(args.guildId),
      String(args.nitradoConnId),
      args.accountId,
    );
    await insertManagers(raw, {
      accountId: args.accountId,
      guildId: args.guildId,
      connId: args.nitradoConnId,
      managers,
      actor: args.updatedByDiscordId,
    });
  });

  const [updated, finance] = await Promise.all([
    getVirtualAccountById(args.guildId, args.nitradoConnId, args.accountId),
    ensureVirtualAccountFinance(args.guildId, args.nitradoConnId, args.accountId),
  ]);
  if (!updated) throw new Error('Virtuelles Konto konnte nach Update nicht gelesen werden.');
  return { account: updated, finance };
}
