import { randomInt, randomUUID } from 'node:crypto';
import type { Client, TextChannel } from 'discord.js';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { assertEconomyScopeReady } from './scopeMigration';
import { transferVirtualAccountToUser, type EconomyPocket } from './virtualAccounts';
import { logger, logAudit } from '../../utils/logger';

export type LotteryStatus = 'OPEN' | 'DRAWING' | 'REFUNDING' | 'COMPLETED' | 'REFUNDED' | 'CANCELLED';

export interface LotteryRow {
  id: string;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  potVirtualAccountId: string;
  name: string;
  nameKey: string;
  status: LotteryStatus;
  ticketPrice: bigint;
  maxTicketsPerUser: number;
  minParticipants: number;
  drawAt: Date;
  winnerDiscordId: string | null;
  payoutAmount: bigint | null;
  channelId: string | null;
  resultNotifiedAt: Date | null;
  createdByDiscordId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface LotterySummary extends LotteryRow {
  participantCount: number;
  ticketCount: number;
  potBalance: bigint;
}

type DbLotteryRow = Omit<LotteryRow, 'guildId' | 'nitradoConnId'> & { guildId: string; nitradoConnId: string };
type RawDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

const MAX_TICKET_PRICE = 1_000_000_000_000_000n;
const MAX_TICKETS_PER_USER = 1000;
const MAX_MIN_PARTICIPANTS = 10_000;
let schedulerTimer: NodeJS.Timeout | null = null;
let schedulerRunning = false;

function db(): RawDb { return prisma as unknown as RawDb; }
function toLottery(row: DbLotteryRow): LotteryRow {
  return { ...row, guildId: row.guildId as GuildId, nitradoConnId: row.nitradoConnId as NitradoConnId };
}
function nameParts(raw: string): { name: string; nameKey: string } {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length < 1 || name.length > 80 || /[\r\n\t]/.test(name)) throw new Error('Lotteriename muss 1..80 gueltige Zeichen enthalten.');
  return { name, nameKey: name.toLocaleLowerCase('de-DE') };
}
export function validateLotteryConfig(args: {
  ticketPrice: bigint; maxTicketsPerUser: number; minParticipants: number; drawAt: Date;
}): void {
  if (args.ticketPrice <= 0n || args.ticketPrice > MAX_TICKET_PRICE) throw new Error('Ticketpreis ist ausserhalb des erlaubten Bereichs.');
  if (!Number.isInteger(args.maxTicketsPerUser) || args.maxTicketsPerUser < 1 || args.maxTicketsPerUser > MAX_TICKETS_PER_USER) throw new Error('Ticketlimit muss zwischen 1 und 1000 liegen.');
  if (!Number.isInteger(args.minParticipants) || args.minParticipants < 2 || args.minParticipants > MAX_MIN_PARTICIPANTS) throw new Error('Mindestteilnehmer muss zwischen 2 und 10000 liegen.');
  if (!(args.drawAt instanceof Date) || !Number.isFinite(args.drawAt.getTime()) || args.drawAt.getTime() <= Date.now()) throw new Error('Ziehungszeit muss in der Zukunft liegen.');
}

export function selectWeightedWinner(rows: Array<{ userDiscordId: string; tickets: number }>, randomTicket: number): string {
  const total = rows.reduce((sum, row) => sum + row.tickets, 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Keine gueltigen Tickets fuer Ziehung.');
  if (!Number.isInteger(randomTicket) || randomTicket < 0 || randomTicket >= total) throw new Error('Ziehungsindex ausserhalb des Ticketpools.');
  let cursor = randomTicket;
  for (const row of rows) {
    if (!Number.isInteger(row.tickets) || row.tickets <= 0) throw new Error('Ungueltige Ticketgewichtung.');
    if (cursor < row.tickets) return row.userDiscordId;
    cursor -= row.tickets;
  }
  throw new Error('Gewinner konnte nicht bestimmt werden.');
}

async function summaryFrom(raw: RawDb, row: DbLotteryRow): Promise<LotterySummary> {
  const [stats] = await raw.$queryRawUnsafe<Array<{ participants: bigint; tickets: bigint; balance: bigint }>>(
    'SELECT COUNT(DISTINCT p."userDiscordId")::bigint AS participants, COALESCE(SUM(p."quantity"),0)::bigint AS tickets, v."balance" FROM "EconomyLottery" l JOIN "EconomyVirtualAccount" v ON v."id"=l."potVirtualAccountId" LEFT JOIN "EconomyLotteryPurchase" p ON p."lotteryId"=l."id" WHERE l."id"=$1 AND l."guildId"=$2 AND l."nitradoConnId"=$3 GROUP BY v."balance"',
    row.id, row.guildId, row.nitradoConnId,
  );
  return {
    ...toLottery(row),
    participantCount: Number(stats?.participants ?? 0n),
    ticketCount: Number(stats?.tickets ?? 0n),
    potBalance: stats?.balance ?? 0n,
  };
}

export async function listLotteries(guildId: GuildId, nitradoConnId: NitradoConnId, includeTerminal = true): Promise<LotterySummary[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const raw = db();
  const rows = await raw.$queryRawUnsafe<DbLotteryRow[]>(
    'SELECT "id","guildId","nitradoConnId","potVirtualAccountId","name","nameKey","status"::text AS status,"ticketPrice","maxTicketsPerUser","minParticipants","drawAt","winnerDiscordId","payoutAmount","channelId","resultNotifiedAt","createdByDiscordId","createdAt","updatedAt" FROM "EconomyLottery" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND ($3::boolean OR "status" IN (\'OPEN\',\'DRAWING\',\'REFUNDING\')) ORDER BY "createdAt" DESC',
    String(guildId), String(nitradoConnId), includeTerminal,
  );
  return Promise.all(rows.map(row => summaryFrom(raw, row)));
}

export async function getLotteryById(guildId: GuildId, nitradoConnId: NitradoConnId, lotteryId: string): Promise<LotterySummary | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const raw = db();
  const rows = await raw.$queryRawUnsafe<DbLotteryRow[]>(
    'SELECT "id","guildId","nitradoConnId","potVirtualAccountId","name","nameKey","status"::text AS status,"ticketPrice","maxTicketsPerUser","minParticipants","drawAt","winnerDiscordId","payoutAmount","channelId","resultNotifiedAt","createdByDiscordId","createdAt","updatedAt" FROM "EconomyLottery" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1',
    lotteryId, String(guildId), String(nitradoConnId),
  );
  return rows[0] ? summaryFrom(raw, rows[0]) : null;
}

export async function getLotteryByName(guildId: GuildId, nitradoConnId: NitradoConnId, rawName: string): Promise<LotterySummary | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const { nameKey } = nameParts(rawName);
  const raw = db();
  const rows = await raw.$queryRawUnsafe<DbLotteryRow[]>(
    'SELECT "id","guildId","nitradoConnId","potVirtualAccountId","name","nameKey","status"::text AS status,"ticketPrice","maxTicketsPerUser","minParticipants","drawAt","winnerDiscordId","payoutAmount","channelId","resultNotifiedAt","createdByDiscordId","createdAt","updatedAt" FROM "EconomyLottery" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "nameKey"=$3 LIMIT 1',
    String(guildId), String(nitradoConnId), nameKey,
  );
  return rows[0] ? summaryFrom(raw, rows[0]) : null;
}

export async function createLottery(args: {
  guildId: GuildId; nitradoConnId: NitradoConnId; name: string; ticketPrice: bigint;
  maxTicketsPerUser: number; minParticipants: number; drawAt: Date; channelId?: string | null;
  createdByDiscordId: UserDiscordId;
}): Promise<LotterySummary> {
  const { name, nameKey } = nameParts(args.name);
  validateLotteryConfig(args);
  if (args.channelId && !/^\d{17,20}$/.test(args.channelId)) throw new Error('Discord-Kanal-ID ist ungueltig.');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const lotteryId = randomUUID();
  const potId = randomUUID();
  const potName = `Lotterie · ${name}`.slice(0, 80);
  const potNameKey = `lottery:${lotteryId}`;
  try {
    await prisma.$transaction(async tx => {
      const raw = tx as unknown as RawDb;
      await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyVirtualAccount" ("id","guildId","nitradoConnId","kind","name","nameKey","balance","status","acceptUserTransfers","expiresAt","createdByDiscordId","createdAt","updatedAt") VALUES ($1,$2,$3,\'LOTTERY_POT\'::"EconomyVirtualAccountKind",$4,$5,0,\'ACTIVE\'::"EconomyVirtualAccountStatus",false,NULL,$6,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        potId, String(args.guildId), String(args.nitradoConnId), potName, potNameKey, String(args.createdByDiscordId),
      );
      await raw.$executeRawUnsafe(
        'INSERT INTO "EconomyLottery" ("id","guildId","nitradoConnId","potVirtualAccountId","name","nameKey","status","ticketPrice","maxTicketsPerUser","minParticipants","drawAt","channelId","createdByDiscordId","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,\'OPEN\'::"EconomyLotteryStatus",$7,$8,$9,$10,$11,$12,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)',
        lotteryId, String(args.guildId), String(args.nitradoConnId), potId, name, nameKey, args.ticketPrice,
        args.maxTicketsPerUser, args.minParticipants, args.drawAt, args.channelId ?? null, String(args.createdByDiscordId),
      );
    });
  } catch (error) {
    const candidate = error as { code?: string; meta?: { code?: string } };
    if (candidate?.code === '23505' || candidate?.code === 'P2002' || candidate?.meta?.code === '23505') throw new Error('Eine Lotterie mit diesem Namen existiert bereits auf diesem Gameserver.');
    throw error;
  }
  const result = await getLotteryById(args.guildId, args.nitradoConnId, lotteryId);
  if (!result) throw new Error('Lotterie konnte nach Erstellung nicht geladen werden.');
  return result;
}

async function writePurchaseUserAudit(raw: RawDb, args: {
  operationKey: string; guildId: GuildId; nitradoConnId: NitradoConnId; userDiscordId: UserDiscordId;
  amount: bigint; sourcePocket: EconomyPocket; lotteryId: string; reason: string;
}): Promise<void> {
  const txType = args.sourcePocket === 'WALLET' ? 'PAY' : 'TRANSFER';
  await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyTransaction" ("id","guildId","nitradoConnId","userDiscordId","delta","type","reason","actorDiscordId","counterpartDiscordId","createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$4,NULL,CURRENT_TIMESTAMP)',
    randomUUID(), String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId), -args.amount, txType, args.reason,
  );
  const changed = await raw.$executeRawUnsafe(
    'INSERT INTO "EconomyLedgerEntry" ("id","idempotencyKey","guildId","nitradoConnId","userDiscordId","walletDelta","bankDelta","type","reason","buckets","sourceRef","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::"EconomyTxType",$9,0,$10,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
    randomUUID(), `${args.operationKey}:user`, String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId),
    args.sourcePocket === 'WALLET' ? -args.amount : 0n, args.sourcePocket === 'BANK' ? -args.amount : 0n,
    txType, args.reason, `lottery:${args.lotteryId}`,
  );
  if (changed !== 1) throw new Error('User-Ledger-Idempotenzkonflikt bei Ticketkauf.');
}

export async function buyLotteryTickets(args: {
  idempotencyKey: string; guildId: GuildId; nitradoConnId: NitradoConnId; lotteryId: string;
  userDiscordId: UserDiscordId; quantity: number; sourcePocket: EconomyPocket;
}): Promise<{ booked: boolean; lottery: LotterySummary; userTickets: number }> {
  if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > MAX_TICKETS_PER_USER) throw new Error('Ticketanzahl muss zwischen 1 und 1000 liegen.');
  if (args.sourcePocket !== 'WALLET' && args.sourcePocket !== 'BANK') throw new Error('Quellkonto ungueltig.');
  if (!args.idempotencyKey || args.idempotencyKey.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(args.idempotencyKey)) throw new Error('Idempotency-Key ungueltig.');
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const operationKey = `lottery:${String(args.guildId)}:${String(args.nitradoConnId)}:${args.idempotencyKey}`;
  let userTickets = 0;
  let booked = false;

  await prisma.$transaction(async tx => {
    const raw = tx as unknown as RawDb;
    const lotteries = await raw.$queryRawUnsafe<DbLotteryRow[]>(
      'SELECT "id","guildId","nitradoConnId","potVirtualAccountId","name","nameKey","status"::text AS status,"ticketPrice","maxTicketsPerUser","minParticipants","drawAt","winnerDiscordId","payoutAmount","channelId","resultNotifiedAt","createdByDiscordId","createdAt","updatedAt" FROM "EconomyLottery" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 FOR UPDATE',
      args.lotteryId, String(args.guildId), String(args.nitradoConnId),
    );
    const lottery = lotteries[0];
    if (!lottery) throw new Error('Lotterie nicht gefunden.');
    if (lottery.status !== 'OPEN' || lottery.drawAt.getTime() <= Date.now()) throw new Error('Lotterie nimmt keine Tickets mehr an.');

    const existing = await raw.$queryRawUnsafe<Array<{ id: string; userDiscordId: string; quantity: number; sourcePocket: string; amount: bigint }>>(
      'SELECT "id","userDiscordId","quantity","sourcePocket","amount" FROM "EconomyLotteryPurchase" WHERE "idempotencyKey"=$1 LIMIT 1', operationKey,
    );
    if (existing[0]) {
      const e = existing[0];
      const expectedAmount = lottery.ticketPrice * BigInt(args.quantity);
      if (e.userDiscordId !== String(args.userDiscordId) || e.quantity !== args.quantity || e.sourcePocket !== args.sourcePocket || e.amount !== expectedAmount) throw new Error('Idempotency-Key wurde bereits fuer eine andere Ticketbuchung verwendet.');
      const totals = await raw.$queryRawUnsafe<Array<{ total: bigint }>>('SELECT COALESCE(SUM("quantity"),0)::bigint AS total FROM "EconomyLotteryPurchase" WHERE "lotteryId"=$1 AND "userDiscordId"=$2', args.lotteryId, String(args.userDiscordId));
      userTickets = Number(totals[0]?.total ?? 0n);
      return;
    }

    const totals = await raw.$queryRawUnsafe<Array<{ total: bigint }>>('SELECT COALESCE(SUM("quantity"),0)::bigint AS total FROM "EconomyLotteryPurchase" WHERE "lotteryId"=$1 AND "userDiscordId"=$2', args.lotteryId, String(args.userDiscordId));
    const previous = Number(totals[0]?.total ?? 0n);
    if (previous + args.quantity > lottery.maxTicketsPerUser) throw new Error(`Ticketlimit erreicht. Maximal ${lottery.maxTicketsPerUser} Tickets pro User.`);
    const amount = lottery.ticketPrice * BigInt(args.quantity);
    const column = args.sourcePocket === 'WALLET' ? 'walletBalance' : 'bankBalance';
    const debit = await raw.$executeRawUnsafe(
      `UPDATE "EconomyAccount" SET "${column}"="${column}"-$4, "updatedAt"=CURRENT_TIMESTAMP WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 AND "${column}">=$4`,
      String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId), amount,
    );
    if (debit !== 1) throw new Error(args.sourcePocket === 'WALLET' ? 'Wallet zu klein.' : 'Bankguthaben zu klein.');

    const purchaseId = randomUUID();
    await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyLotteryPurchase" ("id","idempotencyKey","guildId","nitradoConnId","lotteryId","userDiscordId","quantity","ticketPrice","amount","sourcePocket","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CURRENT_TIMESTAMP)',
      purchaseId, operationKey, String(args.guildId), String(args.nitradoConnId), args.lotteryId, String(args.userDiscordId), args.quantity, lottery.ticketPrice, amount, args.sourcePocket,
    );
    const virtualEntry = await raw.$executeRawUnsafe(
      'INSERT INTO "EconomyVirtualAccountEntry" ("id","idempotencyKey","guildId","nitradoConnId","virtualAccountId","delta","entryType","sourcePocket","actorDiscordId","userDiscordId","reason","sourceRef","createdAt") VALUES ($1,$2,$3,$4,$5,$6,\'LOTTERY_TICKET\',$7,$8,$8,$9,$10,CURRENT_TIMESTAMP) ON CONFLICT ("idempotencyKey") DO NOTHING',
      randomUUID(), `${operationKey}:pot`, String(args.guildId), String(args.nitradoConnId), lottery.potVirtualAccountId, amount, args.sourcePocket, String(args.userDiscordId), `Lotterie-Tickets: ${lottery.name}`, `lottery:${lottery.id}`,
    );
    if (virtualEntry !== 1) throw new Error('Pot-Ledger-Idempotenzkonflikt bei Ticketkauf.');
    const credit = await raw.$executeRawUnsafe('UPDATE "EconomyVirtualAccount" SET "balance"="balance"+$4,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "kind"=\'LOTTERY_POT\'::"EconomyVirtualAccountKind"', lottery.potVirtualAccountId, String(args.guildId), String(args.nitradoConnId), amount);
    if (credit !== 1) throw new Error('Lotterie-Pot konnte nicht aktualisiert werden.');
    await writePurchaseUserAudit(raw, { operationKey, guildId: args.guildId, nitradoConnId: args.nitradoConnId, userDiscordId: args.userDiscordId, amount, sourcePocket: args.sourcePocket, lotteryId: lottery.id, reason: `Lotterie-Tickets: ${lottery.name}` });
    userTickets = previous + args.quantity;
    booked = true;
  });

  const lottery = await getLotteryById(args.guildId, args.nitradoConnId, args.lotteryId);
  if (!lottery) throw new Error('Lotterie konnte nach Ticketkauf nicht geladen werden.');
  return { booked, lottery, userTickets };
}

async function claimResolution(lotteryId: string): Promise<void> {
  await prisma.$transaction(async tx => {
    const raw = tx as unknown as RawDb;
    const rows = await raw.$queryRawUnsafe<DbLotteryRow[]>(
      'SELECT "id","guildId","nitradoConnId","potVirtualAccountId","name","nameKey","status"::text AS status,"ticketPrice","maxTicketsPerUser","minParticipants","drawAt","winnerDiscordId","payoutAmount","channelId","resultNotifiedAt","createdByDiscordId","createdAt","updatedAt" FROM "EconomyLottery" WHERE "id"=$1 FOR UPDATE', lotteryId,
    );
    const lottery = rows[0];
    if (!lottery || lottery.status !== 'OPEN' || lottery.drawAt.getTime() > Date.now()) return;
    const weights = await raw.$queryRawUnsafe<Array<{ userDiscordId: string; tickets: bigint }>>(
      'SELECT "userDiscordId", SUM("quantity")::bigint AS tickets FROM "EconomyLotteryPurchase" WHERE "lotteryId"=$1 GROUP BY "userDiscordId" ORDER BY "userDiscordId"', lotteryId,
    );
    if (weights.length < lottery.minParticipants) {
      await raw.$executeRawUnsafe('UPDATE "EconomyLottery" SET "status"=\'REFUNDING\'::"EconomyLotteryStatus","updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "status"=\'OPEN\'::"EconomyLotteryStatus"', lotteryId);
      return;
    }
    const weighted = weights.map(w => ({ userDiscordId: w.userDiscordId, tickets: Number(w.tickets) }));
    const total = weighted.reduce((sum, row) => sum + row.tickets, 0);
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error('Ticketpool ist fuer sichere Gewinnerziehung ungueltig.');
    const winner = selectWeightedWinner(weighted, randomInt(total));
    const balances = await raw.$queryRawUnsafe<Array<{ balance: bigint }>>('SELECT "balance" FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 FOR UPDATE', lottery.potVirtualAccountId, lottery.guildId, lottery.nitradoConnId);
    const payoutAmount = balances[0]?.balance ?? 0n;
    if (payoutAmount <= 0n) throw new Error('Lotterie-Pot ist leer, obwohl gueltige Tickets existieren.');
    await raw.$executeRawUnsafe('UPDATE "EconomyLottery" SET "status"=\'DRAWING\'::"EconomyLotteryStatus","winnerDiscordId"=$2,"payoutAmount"=$3,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "status"=\'OPEN\'::"EconomyLotteryStatus"', lotteryId, winner, payoutAmount);
  });
}

async function settleWinner(lottery: LotteryRow): Promise<void> {
  if (lottery.status !== 'DRAWING' || !lottery.winnerDiscordId || !lottery.payoutAmount || lottery.payoutAmount <= 0n) return;
  await transferVirtualAccountToUser({
    idempotencyKey: `lottery-payout:${lottery.id}`,
    guildId: lottery.guildId,
    nitradoConnId: lottery.nitradoConnId,
    virtualAccountId: lottery.potVirtualAccountId,
    toUserId: lottery.winnerDiscordId as UserDiscordId,
    amount: lottery.payoutAmount,
    targetPocket: 'WALLET',
    actorDiscordId: null,
    reason: `Lotterie-Gewinn: ${lottery.name}`,
    entryType: 'PAYOUT',
  });
  await db().$executeRawUnsafe('UPDATE "EconomyLottery" SET "status"=\'COMPLETED\'::"EconomyLotteryStatus","updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "status"=\'DRAWING\'::"EconomyLotteryStatus" AND NOT EXISTS (SELECT 1 FROM "EconomyVirtualAccount" v WHERE v."id"="EconomyLottery"."potVirtualAccountId" AND v."balance"<>0)', lottery.id);
}

async function processRefunds(lottery: LotteryRow): Promise<void> {
  if (lottery.status !== 'REFUNDING') return;
  const raw = db();
  const purchases = await raw.$queryRawUnsafe<Array<{ id: string; userDiscordId: string; amount: bigint }>>(
    'SELECT "id","userDiscordId","amount" FROM "EconomyLotteryPurchase" WHERE "lotteryId"=$1 AND "refundedAt" IS NULL ORDER BY "createdAt","id" LIMIT 100', lottery.id,
  );
  for (const purchase of purchases) {
    await transferVirtualAccountToUser({
      idempotencyKey: `lottery-refund:${lottery.id}:${purchase.id}`,
      guildId: lottery.guildId,
      nitradoConnId: lottery.nitradoConnId,
      virtualAccountId: lottery.potVirtualAccountId,
      toUserId: purchase.userDiscordId as UserDiscordId,
      amount: purchase.amount,
      targetPocket: 'WALLET',
      actorDiscordId: null,
      reason: `Lotterie-Refund: ${lottery.name}`,
      entryType: 'REFUND',
    });
    await raw.$executeRawUnsafe('UPDATE "EconomyLotteryPurchase" SET "refundedAt"=COALESCE("refundedAt",CURRENT_TIMESTAMP) WHERE "id"=$1 AND "lotteryId"=$2', purchase.id, lottery.id);
  }
  const remaining = await raw.$queryRawUnsafe<Array<{ count: bigint; balance: bigint }>>(
    'SELECT (SELECT COUNT(*)::bigint FROM "EconomyLotteryPurchase" WHERE "lotteryId"=$1 AND "refundedAt" IS NULL) AS count, (SELECT "balance" FROM "EconomyVirtualAccount" WHERE "id"=$2) AS balance', lottery.id, lottery.potVirtualAccountId,
  );
  if ((remaining[0]?.count ?? 0n) === 0n && (remaining[0]?.balance ?? 0n) === 0n) {
    await raw.$executeRawUnsafe('UPDATE "EconomyLottery" SET "status"=\'REFUNDED\'::"EconomyLotteryStatus","updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "status"=\'REFUNDING\'::"EconomyLotteryStatus"', lottery.id);
  }
}

export async function cancelLottery(guildId: GuildId, nitradoConnId: NitradoConnId, lotteryId: string): Promise<LotterySummary> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const changed = await db().$executeRawUnsafe('UPDATE "EconomyLottery" SET "status"=\'REFUNDING\'::"EconomyLotteryStatus","updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "status"=\'OPEN\'::"EconomyLotteryStatus"', lotteryId, String(guildId), String(nitradoConnId));
  if (changed !== 1) throw new Error('Nur offene Lotterien koennen storniert werden.');
  await processLottery(lotteryId);
  const result = await getLotteryById(guildId, nitradoConnId, lotteryId);
  if (!result) throw new Error('Lotterie nach Storno nicht gefunden.');
  return result;
}

export async function processLottery(lotteryId: string): Promise<LotterySummary | null> {
  const baseRows = await db().$queryRawUnsafe<DbLotteryRow[]>('SELECT "id","guildId","nitradoConnId","potVirtualAccountId","name","nameKey","status"::text AS status,"ticketPrice","maxTicketsPerUser","minParticipants","drawAt","winnerDiscordId","payoutAmount","channelId","resultNotifiedAt","createdByDiscordId","createdAt","updatedAt" FROM "EconomyLottery" WHERE "id"=$1 LIMIT 1', lotteryId);
  const base = baseRows[0];
  if (!base) return null;
  await assertEconomyScopeReady(base.guildId as GuildId, base.nitradoConnId as NitradoConnId);
  if (base.status === 'OPEN') await claimResolution(lotteryId);
  let current = await getLotteryById(base.guildId as GuildId, base.nitradoConnId as NitradoConnId, lotteryId);
  if (!current) return null;
  if (current.status === 'DRAWING') await settleWinner(current);
  if (current.status === 'REFUNDING') await processRefunds(current);
  current = await getLotteryById(base.guildId as GuildId, base.nitradoConnId as NitradoConnId, lotteryId);
  return current;
}

async function notifyTerminal(client: Client, lottery: LotterySummary): Promise<void> {
  if (!lottery.channelId || lottery.resultNotifiedAt || !['COMPLETED', 'REFUNDED'].includes(lottery.status)) return;
  try {
    const channel = await client.channels.fetch(lottery.channelId) as TextChannel | null;
    if (!channel?.isTextBased()) return;
    const content = lottery.status === 'COMPLETED'
      ? `🎟️ **${lottery.name}** wurde gezogen. Gewinner: <@${lottery.winnerDiscordId}> · Gewinn: **${lottery.payoutAmount?.toLocaleString('de-DE') ?? '0'}**.`
      : `🎟️ **${lottery.name}** wurde mangels Mindestteilnehmern beendet. Alle Ticketkaeufe wurden automatisch erstattet.`;
    await channel.send({ content, allowedMentions: lottery.winnerDiscordId ? { users: [lottery.winnerDiscordId] } : { parse: [] } });
    await db().$executeRawUnsafe('UPDATE "EconomyLottery" SET "resultNotifiedAt"=CURRENT_TIMESTAMP,"updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "resultNotifiedAt" IS NULL', lottery.id);
  } catch (error) {
    logger.error(`Lotterie-Ergebnisbenachrichtigung fehlgeschlagen (${lottery.id}):`, error as Error);
  }
}

export async function processDueLotteries(client?: Client): Promise<number> {
  const rows = await db().$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT "id" FROM "EconomyLottery" WHERE ("status"=\'OPEN\'::"EconomyLotteryStatus" AND "drawAt"<=CURRENT_TIMESTAMP) OR "status" IN (\'DRAWING\',\'REFUNDING\') ORDER BY "drawAt","id" LIMIT 200',
  );
  let processed = 0;
  for (const row of rows) {
    try {
      const lottery = await processLottery(row.id);
      if (lottery) {
        processed += 1;
        if (client) await notifyTerminal(client, lottery);
        if (['COMPLETED', 'REFUNDED'].includes(lottery.status)) {
          logAudit('ECONOMY_LOTTERY_SETTLED', 'ECONOMY', { lotteryId: lottery.id, guildId: lottery.guildId, nitradoConnId: lottery.nitradoConnId, status: lottery.status, winnerDiscordId: lottery.winnerDiscordId });
        }
      }
    } catch (error) {
      logger.error(`Lotterie-Verarbeitung fehlgeschlagen (${row.id}):`, error as Error);
    }
  }
  return processed;
}

export function startLotteryScheduler(client: Client): void {
  if (schedulerTimer) return;
  const run = async () => {
    if (schedulerRunning) return;
    schedulerRunning = true;
    try { await processDueLotteries(client); }
    finally { schedulerRunning = false; }
  };
  schedulerTimer = setInterval(() => { void run(); }, 10_000);
  schedulerTimer.unref?.();
  void run();
  logger.info('Lotterie-Scheduler gestartet.');
}

export function stopLotteryScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerRunning = false;
}
