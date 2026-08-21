/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
import { randomInt, randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
  EmbedBuilder,
  MessageFlags,
  type TextChannel,
} from 'discord.js';
import prisma from '../../database/prisma';
import type { GuildId, NitradoConnId, UserDiscordId } from '../../types/scope';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../types/scope';
import { logger, logAudit } from '../../utils/logger';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { safeEmbedDescription } from '../../utils/embedSanitize';
import { assertEconomyScopeReady } from './scopeMigration';
import { archiveVirtualAccount, type VirtualAccountRawDb } from './virtualAccounts';
import { getConfig } from './repository';
import { systemUserToVirtualAccount, systemVirtualAccountToUser } from './systemVirtualTransfers';

let lotterySchedulerTimer: NodeJS.Timeout | null = null;
let lotterySchedulerBusy = false;
const LOTTERY_INTERVAL_MS = 5_000;
const MAX_TOTAL_TICKETS = 1_000_000_000;
const REFUND_BATCH = 50;

export type LotteryStatus = 'ACTIVE' | 'DRAWING' | 'REFUNDING' | 'FINISHED' | 'REFUNDED';

export interface LotteryRoundView {
  id: string;
  guildId: string;
  nitradoConnId: string;
  potAccountId: string;
  channelId: string;
  messageId: string | null;
  ticketPrice: bigint;
  maxTicketsPerUser: number;
  minParticipants: number;
  status: LotteryStatus;
  endsAt: Date;
  winnerDiscordId: string | null;
  winningTicketNumber: number | null;
  participantCount: number;
  totalTickets: number;
  finalPot: bigint | null;
  drawnAt: Date | null;
  settledAt: Date | null;
  announcedAt: Date | null;
  createdByDiscordId: string;
  createdAt: Date;
  updatedAt: Date;
  potBalance: bigint;
}

interface DbLotteryRound {
  id: string;
  guildId: string;
  nitradoConnId: string;
  potAccountId: string;
  channelId: string;
  messageId: string | null;
  ticketPrice: bigint;
  maxTicketsPerUser: number;
  minParticipants: number;
  status: LotteryStatus;
  activeScopeKey: string | null;
  endsAt: Date;
  winnerDiscordId: string | null;
  winningTicketNumber: number | null;
  participantCount: number;
  totalTickets: number;
  finalPot: bigint | null;
  drawnAt: Date | null;
  settledAt: Date | null;
  announcedAt: Date | null;
  createdByDiscordId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface DbLotteryEntry {
  id: string;
  roundId: string;
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  ticketCount: number;
  totalPaid: bigint;
  refundedAt: Date | null;
}

interface DbPotRow { id: string; balance: bigint; status: string; kind: string }

function scopeKey(guildId: GuildId, nitradoConnId: NitradoConnId): string {
  return `${guildId}:${nitradoConnId}`;
}

function makePurchaseKey(roundId: string, idempotencyKey: string): string {
  const key = idempotencyKey.normalize('NFKC').trim();
  if (!key || key.length > 40 || !/^[A-Za-z0-9._:-]+$/.test(key)) throw new Error('Kauf-Idempotency-Key ungueltig.');
  return `lottery-purchase:${roundId}:${key}`;
}

export function validateLotteryConfig(args: {
  ticketPrice: bigint;
  maxTicketsPerUser: number;
  minParticipants: number;
  endsAt: Date;
}): void {
  if (args.ticketPrice <= 0n || args.ticketPrice > 1_000_000_000_000n) throw new Error('Ticketpreis muss zwischen 1 und 1.000.000.000.000 liegen.');
  if (!Number.isInteger(args.maxTicketsPerUser) || args.maxTicketsPerUser < 1 || args.maxTicketsPerUser > 10_000) throw new Error('Ticketlimit muss 1..10000 sein.');
  if (!Number.isInteger(args.minParticipants) || args.minParticipants < 2 || args.minParticipants > 100_000) throw new Error('Mindestteilnehmer muss 2..100000 sein.');
  const duration = args.endsAt.getTime() - Date.now();
  if (!Number.isFinite(args.endsAt.getTime()) || duration < 60_000 || duration > 30 * 24 * 60 * 60 * 1000) {
    throw new Error('Endzeit muss 1 Minute bis 30 Tage in der Zukunft liegen.');
  }
}

export function selectWeightedWinner(entries: Array<{ userDiscordId: string; ticketCount: number }>, drawIndex: number): { userDiscordId: string; winningTicketNumber: number } {
  const totalTickets = entries.reduce((sum, entry) => sum + entry.ticketCount, 0);
  if (!Number.isSafeInteger(totalTickets) || totalTickets <= 0 || totalTickets > MAX_TOTAL_TICKETS) throw new Error('Ticketgesamtzahl ist fuer die Ziehung ungueltig.');
  if (!Number.isInteger(drawIndex) || drawIndex < 0 || drawIndex >= totalTickets) throw new Error('Ziehungsindex ausserhalb des Ticketpools.');
  let cursor = 0;
  for (const entry of entries) {
    if (!Number.isInteger(entry.ticketCount) || entry.ticketCount <= 0) throw new Error('Ungueltige Ticketgewichtung.');
    cursor += entry.ticketCount;
    if (drawIndex < cursor) return { userDiscordId: entry.userDiscordId, winningTicketNumber: drawIndex + 1 };
  }
  throw new Error('Ticketaggregation ist inkonsistent.');
}

async function fetchRoundViewById(roundId: string): Promise<LotteryRoundView | null> {
  const rows = await (prisma as unknown as VirtualAccountRawDb).$queryRawUnsafe<Array<DbLotteryRound & { potBalance: bigint }>>(
    'SELECT r.*, v."balance" AS "potBalance" FROM "LotteryRound" r JOIN "EconomyVirtualAccount" v ON v."id"=r."potAccountId" WHERE r."id"=$1 LIMIT 1',
    roundId,
  );
  return rows[0] ?? null;
}

export async function getLotteryRoundById(guildId: GuildId, nitradoConnId: NitradoConnId, roundId: string): Promise<LotteryRoundView | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const round = await fetchRoundViewById(roundId);
  if (!round || round.guildId !== String(guildId) || round.nitradoConnId !== String(nitradoConnId)) return null;
  return round;
}

export async function getCurrentLotteryRound(guildId: GuildId, nitradoConnId: NitradoConnId): Promise<LotteryRoundView | null> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const rows = await (prisma as unknown as VirtualAccountRawDb).$queryRawUnsafe<Array<DbLotteryRound & { potBalance: bigint }>>(
    'SELECT r.*, v."balance" AS "potBalance" FROM "LotteryRound" r JOIN "EconomyVirtualAccount" v ON v."id"=r."potAccountId" WHERE r."guildId"=$1 AND r."nitradoConnId"=$2 AND r."activeScopeKey"=$3 LIMIT 1',
    String(guildId), String(nitradoConnId), scopeKey(guildId, nitradoConnId),
  );
  return rows[0] ?? null;
}

export async function listLotteryHistory(guildId: GuildId, nitradoConnId: NitradoConnId, limit = 20): Promise<LotteryRoundView[]> {
  await assertEconomyScopeReady(guildId, nitradoConnId);
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  return (prisma as unknown as VirtualAccountRawDb).$queryRawUnsafe<Array<DbLotteryRound & { potBalance: bigint }>>(
    'SELECT r.*, v."balance" AS "potBalance" FROM "LotteryRound" r JOIN "EconomyVirtualAccount" v ON v."id"=r."potAccountId" WHERE r."guildId"=$1 AND r."nitradoConnId"=$2 ORDER BY r."createdAt" DESC LIMIT $3',
    String(guildId), String(nitradoConnId), safeLimit,
  );
}

export async function getLotteryEntry(roundId: string, userDiscordId: UserDiscordId): Promise<{ ticketCount: number; totalPaid: bigint; refundedAt: Date | null } | null> {
  const row = await prisma.lotteryEntry.findUnique({
    where: { roundUser: { roundId, userDiscordId: String(userDiscordId) } },
    select: { ticketCount: true, totalPaid: true, refundedAt: true },
  });
  return row ?? null;
}

export async function createLotteryEmbed(round: LotteryRoundView): Promise<EmbedBuilder> {
  const cfg = await getConfig(asGuildId(round.guildId), asNitradoConnId(round.nitradoConnId));
  const active = round.status === 'ACTIVE' && round.endsAt.getTime() > Date.now();
  const lines: string[] = [Brand.divider];
  if (active) {
    lines.push(`🎟️ **Ticket:** ${round.ticketPrice.toLocaleString('de-DE')} ${cfg.emoji}`);
    lines.push(`💰 **Pot:** ${round.potBalance.toLocaleString('de-DE')} ${cfg.emoji}`);
    lines.push(`👥 **Teilnehmer:** ${round.participantCount} / mindestens ${round.minParticipants}`);
    lines.push(`🎫 **Tickets:** ${round.totalTickets} · max. ${round.maxTicketsPerUser} pro User`);
    lines.push(`⏰ **Endet:** <t:${Math.floor(round.endsAt.getTime() / 1000)}:R>`);
    lines.push('', 'Mit dem Button kaufst du **1 Ticket aus deinem Wallet**. Mehrere Tickets kannst du mit `/lottery buy` kaufen.');
  } else if (round.status === 'ACTIVE') {
    lines.push('⏳ **Teilnahme beendet. Die Auswertung läuft.**');
    lines.push('Neue Ticketkäufe sind geschlossen; Ziehung oder Refund wird automatisch verarbeitet.');
  } else if (round.status === 'DRAWING') {
    lines.push('🎲 **Ziehung läuft.** Die Runde ist fuer neue Kaeufe geschlossen.');
    lines.push(`💰 **Finaler Pot:** ${(round.finalPot ?? round.potBalance).toLocaleString('de-DE')} ${cfg.emoji}`);
  } else if (round.status === 'REFUNDING') {
    lines.push('↩️ **Refund läuft.** Die Mindestteilnehmerzahl wurde nicht erreicht.');
    lines.push('Alle bestaetigten Ticketkaeufe werden idempotent ins Wallet zurueckgezahlt.');
  } else if (round.status === 'FINISHED') {
    lines.push(`🏆 **Gewinner:** ${round.winnerDiscordId ? `<@${round.winnerDiscordId}>` : '—'}`);
    lines.push(`💰 **Ausgezahlt:** ${(round.finalPot ?? 0n).toLocaleString('de-DE')} ${cfg.emoji}`);
    if (round.winningTicketNumber) lines.push(`🎫 **Gewinn-Ticket:** #${round.winningTicketNumber}`);
  } else {
    lines.push('↩️ **Runde beendet und vollstaendig erstattet.**');
    lines.push(`👥 Teilnehmer: ${round.participantCount} / benoetigt: ${round.minParticipants}`);
  }
  lines.push(Brand.divider);
  return vEmbed(active ? Colors.Giveaway : round.status === 'FINISHED' ? Colors.Success : Colors.Neutral)
    .setTitle(active ? '🎟️ LOTTERIE' : '🎟️ LOTTERIE · ERGEBNIS')
    .setDescription(safeEmbedDescription(lines.join('\n')))
    .setFooter({ text: `${Brand.footerText} ${Brand.dot} Lotterie` });
}

export function createLotteryButtons(round: LotteryRoundView): ActionRowBuilder<ButtonBuilder>[] {
  if (round.status !== 'ACTIVE' || round.endsAt.getTime() <= Date.now()) return [];
  const buttons = [new ButtonBuilder()
    .setCustomId(`lottery_buy_1_${round.id}`)
    .setLabel('1 Ticket kaufen')
    .setEmoji('🎟️')
    .setStyle(ButtonStyle.Success)];
  if (round.maxTicketsPerUser >= 5) {
    buttons.push(new ButtonBuilder()
      .setCustomId(`lottery_buy_5_${round.id}`)
      .setLabel('5 Tickets')
      .setStyle(ButtonStyle.Primary));
  }
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)];
}

export async function refreshLotteryMessage(client: Client, roundId: string): Promise<void> {
  const round = await fetchRoundViewById(roundId);
  if (!round?.messageId) return;
  const channel = await client.channels.fetch(round.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('messages' in channel)) throw new Error('Lotterie-Channel nicht erreichbar.');
  const message = await (channel as TextChannel).messages.fetch(round.messageId);
  await message.edit({ embeds: [await createLotteryEmbed(round)], components: createLotteryButtons(round) });
}

export async function createLotteryRound(args: {
  client: Client;
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  channelId: string;
  ticketPrice: bigint;
  maxTicketsPerUser: number;
  minParticipants: number;
  endsAt: Date;
  createdByDiscordId: UserDiscordId;
}): Promise<LotteryRoundView> {
  validateLotteryConfig(args);
  await assertEconomyScopeReady(args.guildId, args.nitradoConnId);
  const cfg = await getConfig(args.guildId, args.nitradoConnId);
  if (!cfg.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');

  const guild = args.client.guilds.cache.get(String(args.guildId));
  if (!guild) throw new Error('Discord-Guild ist auf diesem Bot nicht verfuegbar.');
  const channel = await guild.channels.fetch(args.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) throw new Error('Lotterie-Channel ist kein beschreibbarer Text-Channel.');

  const roundId = randomUUID();
  const potId = randomUUID();
  const potName = `Lotterie ${roundId}`;
  const preview: LotteryRoundView = {
    id: roundId, guildId: String(args.guildId), nitradoConnId: String(args.nitradoConnId), potAccountId: potId,
    channelId: args.channelId, messageId: null, ticketPrice: args.ticketPrice,
    maxTicketsPerUser: args.maxTicketsPerUser, minParticipants: args.minParticipants, status: 'ACTIVE', endsAt: args.endsAt,
    winnerDiscordId: null, winningTicketNumber: null, participantCount: 0, totalTickets: 0, finalPot: null,
    drawnAt: null, settledAt: null, announcedAt: null, createdByDiscordId: String(args.createdByDiscordId),
    createdAt: new Date(), updatedAt: new Date(), potBalance: 0n,
  };

  const message = await (channel as TextChannel).send({
    embeds: [await createLotteryEmbed(preview)],
    components: createLotteryButtons(preview),
    allowedMentions: { parse: [] },
  });

  try {
    await prisma.$transaction(async tx => {
      await tx.economyVirtualAccount.create({
        data: {
          id: potId,
          guildId: String(args.guildId),
          nitradoConnId: String(args.nitradoConnId),
          kind: 'LOTTERY_POT',
          name: potName,
          nameKey: potName.toLowerCase(),
          balance: 0n,
          status: 'ACTIVE',
          acceptUserTransfers: false,
          createdByDiscordId: String(args.createdByDiscordId),
        },
      });
      await tx.lotteryRound.create({
        data: {
          id: roundId,
          guildId: String(args.guildId),
          nitradoConnId: String(args.nitradoConnId),
          potAccountId: potId,
          channelId: args.channelId,
          messageId: message.id,
          ticketPrice: args.ticketPrice,
          maxTicketsPerUser: args.maxTicketsPerUser,
          minParticipants: args.minParticipants,
          status: 'ACTIVE',
          activeScopeKey: scopeKey(args.guildId, args.nitradoConnId),
          endsAt: args.endsAt,
          createdByDiscordId: String(args.createdByDiscordId),
        },
      });
    });
  } catch (error) {
    await message.delete().catch(() => undefined);
    const candidate = typeof error === 'object' && error !== null ? error as { code?: string; meta?: { code?: string } } : {};
    if (candidate.code === 'P2002' || candidate.code === '23505' || candidate.meta?.code === '23505') {
      throw new Error('Auf diesem Gameserver laeuft bereits eine Lotterie.');
    }
    throw error;
  }

  logAudit('LOTTERY_CREATED', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, roundId, potAccountId: potId,
    ticketPrice: args.ticketPrice.toString(), maxTicketsPerUser: args.maxTicketsPerUser,
    minParticipants: args.minParticipants, endsAt: args.endsAt.toISOString(),
  });
  return (await fetchRoundViewById(roundId))!;
}

export async function buyLotteryTickets(args: {
  guildId: GuildId;
  nitradoConnId: NitradoConnId;
  roundId: string;
  userDiscordId: UserDiscordId;
  quantity: number;
  idempotencyKey: string;
}): Promise<{ booked: boolean; ticketCount: number; totalPaid: bigint; refundedAt: Date | null; round: LotteryRoundView }> {
  if (!Number.isInteger(args.quantity) || args.quantity < 1 || args.quantity > 100) throw new Error('Pro Kauf sind 1..100 Tickets erlaubt.');
  const key = makePurchaseKey(args.roundId, args.idempotencyKey);
  const initial = await fetchRoundViewById(args.roundId);
  if (!initial || initial.guildId !== String(args.guildId) || initial.nitradoConnId !== String(args.nitradoConnId)) throw new Error('Lotterie nicht gefunden.');
  const amount = initial.ticketPrice * BigInt(args.quantity);
  const existing = await prisma.lotteryPurchase.findUnique({ where: { idempotencyKey: key } });
  if (existing) {
    if (existing.userDiscordId !== String(args.userDiscordId)
      || existing.ticketCount !== args.quantity
      || existing.roundId !== args.roundId
      || existing.guildId !== String(args.guildId)
      || existing.nitradoConnId !== String(args.nitradoConnId)
      || existing.amount !== amount) {
      throw new Error('Kauf-Idempotency-Key wurde mit anderen Daten wiederverwendet.');
    }
    const entry = await getLotteryEntry(args.roundId, args.userDiscordId);
    if (!entry) throw new Error('Bestaetigter Lotteriekauf ist inkonsistent.');
    return { booked: false, ...entry, round: initial };
  }

  const cfg = await getConfig(args.guildId, args.nitradoConnId);
  if (!cfg.enabled) throw new Error('Economy ist auf diesem Gameserver deaktiviert.');

  const transfer = await systemUserToVirtualAccount({
    idempotencyKey: key,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    virtualAccountId: initial.potAccountId,
    fromUserId: args.userDiscordId,
    sourcePocket: 'WALLET',
    amount,
    expectedKind: 'LOTTERY_POT',
    economyTxType: 'LOTTERY_TICKET',
    entryType: 'LOTTERY_TICKET',
    reason: `Lotterie: ${args.quantity} Ticket(s)`,
    sourceRef: `lottery:${args.roundId}`,
    actorDiscordId: args.userDiscordId,
  }, {
    beforeClaim: async raw => {
      const rounds = await raw.$queryRawUnsafe<DbLotteryRound[]>(
        'SELECT * FROM "LotteryRound" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
        args.roundId, String(args.guildId), String(args.nitradoConnId),
      );
      const round = rounds[0];
      if (!round) throw new Error('Lotterie nicht gefunden.');
      const replayPurchases = await raw.$queryRawUnsafe<Array<{ roundId: string; guildId: string; nitradoConnId: string; userDiscordId: string; ticketCount: number; amount: bigint }>>(
        'SELECT "roundId", "guildId", "nitradoConnId", "userDiscordId", "ticketCount", "amount" FROM "LotteryPurchase" WHERE "idempotencyKey"=$1 LIMIT 1',
        key,
      );
      const replay = replayPurchases[0];
      if (replay) {
        const same = replay.roundId === args.roundId
          && replay.guildId === String(args.guildId)
          && replay.nitradoConnId === String(args.nitradoConnId)
          && replay.userDiscordId === String(args.userDiscordId)
          && replay.ticketCount === args.quantity
          && replay.amount === amount;
        if (!same) throw new Error('Kauf-Idempotency-Key wurde mit anderen Daten wiederverwendet.');
        return { firstPurchase: false, replay: true };
      }
      if (round.status !== 'ACTIVE' || round.endsAt.getTime() <= Date.now()) throw new Error('Lotterie ist bereits geschlossen.');
      if (round.potAccountId !== initial.potAccountId || round.ticketPrice !== initial.ticketPrice) throw new Error('Lotterie-Konfiguration hat sich unerwartet veraendert.');
      const entries = await raw.$queryRawUnsafe<DbLotteryEntry[]>(
        'SELECT "id", "roundId", "guildId", "nitradoConnId", "userDiscordId", "ticketCount", "totalPaid", "refundedAt" FROM "LotteryEntry" WHERE "roundId"=$1 AND "userDiscordId"=$2 LIMIT 1',
        args.roundId, String(args.userDiscordId),
      );
      const currentTickets = entries[0]?.ticketCount ?? 0;
      if (currentTickets + args.quantity > round.maxTicketsPerUser) throw new Error(`Ticketlimit: maximal ${round.maxTicketsPerUser} pro User.`);
      if (round.totalTickets > MAX_TOTAL_TICKETS - args.quantity) throw new Error('Globales Ticketlimit dieser Runde erreicht.');
      return { firstPurchase: !entries[0] };
    },
    mutate: async ({ raw, preflight }) => {
      await raw.$executeRawUnsafe(
        'INSERT INTO "LotteryPurchase" ("id", "idempotencyKey", "roundId", "guildId", "nitradoConnId", "userDiscordId", "ticketCount", "amount", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,CURRENT_TIMESTAMP)',
        randomUUID(), key, args.roundId, String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId), args.quantity, amount,
      );
      await raw.$executeRawUnsafe(
        'INSERT INTO "LotteryEntry" ("id", "roundId", "guildId", "nitradoConnId", "userDiscordId", "ticketCount", "totalPaid", "refundedAt", "createdAt", "updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT ("roundId", "userDiscordId") DO UPDATE SET "ticketCount"="LotteryEntry"."ticketCount"+EXCLUDED."ticketCount", "totalPaid"="LotteryEntry"."totalPaid"+EXCLUDED."totalPaid", "updatedAt"=CURRENT_TIMESTAMP',
        randomUUID(), args.roundId, String(args.guildId), String(args.nitradoConnId), String(args.userDiscordId), args.quantity, amount,
      );
      await raw.$executeRawUnsafe(
        'UPDATE "LotteryRound" SET "totalTickets"="totalTickets"+$4, "participantCount"="participantCount"+$5, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3',
        args.roundId, String(args.guildId), String(args.nitradoConnId), args.quantity, preflight.firstPurchase ? 1 : 0,
      );
      return true;
    },
  });

  if (!transfer.booked) {
    const replay = await prisma.lotteryPurchase.findUnique({ where: { idempotencyKey: key } });
    if (!replay) throw new Error('Idempotente Geldbuchung ohne Lotteriekauf-Audit gefunden.');
  }
  const entry = await getLotteryEntry(args.roundId, args.userDiscordId);
  const round = await fetchRoundViewById(args.roundId);
  if (!entry || !round) throw new Error('Lotteriekauf konnte nicht vollstaendig gelesen werden.');
  logAudit('LOTTERY_TICKETS_BOUGHT', 'ECONOMY', {
    guildId: args.guildId, nitradoConnId: args.nitradoConnId, roundId: args.roundId,
    userDiscordId: args.userDiscordId, quantity: args.quantity, amount: amount.toString(), booked: transfer.booked,
  });
  return { booked: transfer.booked, ...entry, round };
}

async function prepareSettlement(roundId: string): Promise<LotteryStatus | null> {
  return prisma.$transaction(async tx => {
    const raw = tx as unknown as VirtualAccountRawDb;
    const rounds = await raw.$queryRawUnsafe<DbLotteryRound[]>(
      'SELECT * FROM "LotteryRound" WHERE "id"=$1 LIMIT 1 FOR UPDATE', roundId,
    );
    const round = rounds[0];
    if (!round) return null;
    if (round.status !== 'ACTIVE' || round.endsAt.getTime() > Date.now()) return round.status;

    const entries = await raw.$queryRawUnsafe<DbLotteryEntry[]>(
      'SELECT "id", "roundId", "guildId", "nitradoConnId", "userDiscordId", "ticketCount", "totalPaid", "refundedAt" FROM "LotteryEntry" WHERE "roundId"=$1 ORDER BY "userDiscordId" ASC', roundId,
    );
    const totalTickets = entries.reduce((sum, entry) => sum + entry.ticketCount, 0);
    const totalPaid = entries.reduce((sum, entry) => sum + entry.totalPaid, 0n);
    const pots = await raw.$queryRawUnsafe<DbPotRow[]>(
      'SELECT "id", "balance", "status"::text AS status, "kind"::text AS kind FROM "EconomyVirtualAccount" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 LIMIT 1 FOR UPDATE',
      round.potAccountId, round.guildId, round.nitradoConnId,
    );
    const pot = pots[0];
    if (!pot || pot.kind !== 'LOTTERY_POT' || pot.status === 'ARCHIVED') throw new Error('Lotterie-Pot ist inkonsistent.');
    const entryScopeMismatch = entries.some(entry => entry.guildId !== round.guildId || entry.nitradoConnId !== round.nitradoConnId);
    if (entryScopeMismatch || totalTickets !== round.totalTickets || entries.length !== round.participantCount || pot.balance !== totalPaid) {
      throw new Error(`Lotterie-Invariante verletzt: Tickets/Teilnehmer/Pot stimmen nicht ueberein (${roundId}).`);
    }

    if (entries.length < round.minParticipants) {
      await raw.$executeRawUnsafe(
        'UPDATE "LotteryRound" SET "status"=\'REFUNDING\'::"LotteryRoundStatus", "finalPot"=$2, "drawnAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
        roundId, totalPaid,
      );
      return 'REFUNDING';
    }

    const drawIndex = randomInt(totalTickets);
    const selected = selectWeightedWinner(entries, drawIndex);
    await raw.$executeRawUnsafe(
      'UPDATE "LotteryRound" SET "status"=\'DRAWING\'::"LotteryRoundStatus", "winnerDiscordId"=$2, "winningTicketNumber"=$3, "finalPot"=$4, "drawnAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1',
      roundId, selected.userDiscordId, selected.winningTicketNumber, totalPaid,
    );
    return 'DRAWING';
  });
}

async function completeWinnerPayout(round: LotteryRoundView): Promise<void> {
  if (!round.winnerDiscordId || !round.finalPot || round.finalPot <= 0n) throw new Error('Ziehungsdaten unvollstaendig.');
  await systemVirtualAccountToUser({
    idempotencyKey: `lottery-payout:${round.id}`,
    guildId: asGuildId(round.guildId),
    nitradoConnId: asNitradoConnId(round.nitradoConnId),
    virtualAccountId: round.potAccountId,
    toUserId: asUserDiscordId(round.winnerDiscordId),
    targetPocket: 'WALLET',
    amount: round.finalPot,
    expectedKind: 'LOTTERY_POT',
    economyTxType: 'LOTTERY_PAYOUT',
    entryType: 'LOTTERY_PAYOUT',
    reason: 'Lotterie-Gewinn',
    sourceRef: `lottery:${round.id}`,
    actorDiscordId: null,
    countAsEarned: true,
  }, {
    mutate: async ({ raw }) => {
      const changed = await raw.$executeRawUnsafe(
        'UPDATE "LotteryRound" SET "status"=\'FINISHED\'::"LotteryRoundStatus", "activeScopeKey"=NULL, "settledAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "status"=\'DRAWING\'::"LotteryRoundStatus"',
        round.id,
      );
      if (changed !== 1) throw new Error('Lotterie konnte nach Auszahlung nicht finalisiert werden.');
      return true;
    },
  });
}

async function processRefunds(round: LotteryRoundView): Promise<boolean> {
  const entries = await prisma.lotteryEntry.findMany({
    where: { roundId: round.id, refundedAt: null },
    orderBy: { userDiscordId: 'asc' },
    take: REFUND_BATCH,
  });
  for (const entry of entries) {
    if (entry.totalPaid <= 0n) throw new Error('Refund-Eintrag mit ungueltigem Betrag.');
    await systemVirtualAccountToUser({
      idempotencyKey: `lottery-refund:${round.id}:${entry.userDiscordId}`,
      guildId: asGuildId(round.guildId),
      nitradoConnId: asNitradoConnId(round.nitradoConnId),
      virtualAccountId: round.potAccountId,
      toUserId: asUserDiscordId(entry.userDiscordId),
      targetPocket: 'WALLET',
      amount: entry.totalPaid,
      expectedKind: 'LOTTERY_POT',
      economyTxType: 'LOTTERY_REFUND',
      entryType: 'LOTTERY_REFUND',
      reason: 'Lotterie-Refund: Mindestteilnehmer nicht erreicht',
      sourceRef: `lottery:${round.id}`,
      actorDiscordId: null,
      countAsEarned: false,
    }, {
      mutate: async ({ raw }) => {
        const changed = await raw.$executeRawUnsafe(
          'UPDATE "LotteryEntry" SET "refundedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP WHERE "id"=$1 AND "roundId"=$2 AND "refundedAt" IS NULL',
          entry.id, round.id,
        );
        if (changed !== 1) throw new Error('Refund-Eintrag konnte nicht finalisiert werden.');
        return true;
      },
    });
  }

  const remaining = await prisma.lotteryEntry.count({ where: { roundId: round.id, refundedAt: null } });
  if (remaining > 0) return false;
  const terminal = await fetchRoundViewById(round.id);
  if (!terminal) throw new Error('Refund-Runde ist beim Finalisieren verschwunden.');
  if (terminal.potBalance !== 0n) throw new Error('Refund-Runde kann mit Restguthaben im Pot nicht finalisiert werden.');
  const changed = await prisma.lotteryRound.updateMany({
    where: { id: round.id, status: 'REFUNDING' },
    data: { status: 'REFUNDED', activeScopeKey: null, settledAt: new Date() },
  });
  if (changed.count !== 1) {
    const current = await prisma.lotteryRound.findUnique({ where: { id: round.id }, select: { status: true } });
    if (current?.status !== 'REFUNDED') throw new Error('Refund-Runde konnte nicht finalisiert werden.');
  }
  return true;
}

async function announceTerminalRound(client: Client, roundId: string): Promise<void> {
  const round = await fetchRoundViewById(roundId);
  if (!round || (round.status !== 'FINISHED' && round.status !== 'REFUNDED')) return;
  await refreshLotteryMessage(client, roundId);
  if (round.announcedAt) return;
  if (round.status === 'REFUNDED') {
    await prisma.lotteryRound.updateMany({ where: { id: round.id, status: 'REFUNDED', announcedAt: null }, data: { announcedAt: new Date() } });
    return;
  }
  if (!round.winnerDiscordId) throw new Error('FINISHED-Lotterie ohne Gewinner kann nicht angekündigt werden.');

  const channel = await client.channels.fetch(round.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || !('send' in channel)) throw new Error('Lotterie-Ergebnis-Channel nicht erreichbar.');
  await (channel as TextChannel).send({
    content: `🎉 Glueckwunsch <@${round.winnerDiscordId}>! Du hast den Lotterie-Pot gewonnen.`,
    allowedMentions: { users: [round.winnerDiscordId], parse: [] },
    nonce: `lottery-result-${round.id}`,
    enforceNonce: true,
  });
  await prisma.lotteryRound.updateMany({ where: { id: round.id, announcedAt: null }, data: { announcedAt: new Date() } });
}

async function archiveTerminalPot(roundId: string): Promise<void> {
  const round = await fetchRoundViewById(roundId);
  if (!round || (round.status !== 'FINISHED' && round.status !== 'REFUNDED') || round.potBalance !== 0n) return;
  await archiveVirtualAccount({
    guildId: asGuildId(round.guildId),
    nitradoConnId: asNitradoConnId(round.nitradoConnId),
    accountId: round.potAccountId,
    actorDiscordId: asUserDiscordId(round.createdByDiscordId),
  }).catch(error => logger.warn(`Lotterie-Pot-Archivierung ${round.id}: ${(error as Error).message}`));
}

export async function settleLotteryRound(client: Client, roundId: string): Promise<LotteryRoundView | null> {
  await prepareSettlement(roundId);
  let round = await fetchRoundViewById(roundId);
  if (!round) return null;
  if (round.status === 'DRAWING') {
    await completeWinnerPayout(round);
    round = (await fetchRoundViewById(roundId))!;
  } else if (round.status === 'REFUNDING') {
    await processRefunds(round);
    round = (await fetchRoundViewById(roundId))!;
  }
  if (round.status === 'FINISHED' || round.status === 'REFUNDED') {
    await announceTerminalRound(client, round.id);
    await archiveTerminalPot(round.id);
    round = (await fetchRoundViewById(roundId))!;
  }
  return round;
}

export async function endLotteryNow(client: Client, guildId: GuildId, nitradoConnId: NitradoConnId, roundId: string): Promise<LotteryRoundView> {
  const changed = await prisma.lotteryRound.updateMany({
    where: { id: roundId, guildId: String(guildId), nitradoConnId: String(nitradoConnId), status: 'ACTIVE' },
    data: { endsAt: new Date() },
  });
  if (changed.count !== 1) throw new Error('Aktive Lotterie nicht gefunden.');
  const result = await settleLotteryRound(client, roundId);
  if (!result) throw new Error('Lotterie konnte nicht ausgewertet werden.');
  return result;
}

export async function handleLotteryBuyButton(interaction: ButtonInteraction): Promise<void> {
  const match = interaction.customId.match(/^lottery_buy_(1|5)_([A-Za-z0-9-]+)$/);
  if (!match || !interaction.guildId) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const quantity = Number(match[1]);
  const roundId = match[2];
  const round = await fetchRoundViewById(roundId);
  if (!round || round.guildId !== interaction.guildId) {
    await interaction.editReply({ content: '❌ Lotterie nicht gefunden.' });
    return;
  }
  try {
    const result = await buyLotteryTickets({
      guildId: asGuildId(round.guildId),
      nitradoConnId: asNitradoConnId(round.nitradoConnId),
      roundId,
      userDiscordId: asUserDiscordId(interaction.user.id),
      quantity,
      idempotencyKey: `discord-button:${interaction.id}`,
    });
    await refreshLotteryMessage(interaction.client, roundId).catch(error => {
      logger.warn(`Lotterie-Embed-Refresh nach Button-Kauf ${roundId}: ${(error as Error).message}`);
    });
    await interaction.editReply({
      content: result.booked
        ? `✅ ${quantity} Ticket(s) gekauft. Du hast jetzt **${result.ticketCount}** Ticket(s).`
        : `✅ Dieser Kauf war bereits verarbeitet. Du hast **${result.ticketCount}** Ticket(s).`,
    });
  } catch (error) {
    await interaction.editReply({ content: `❌ ${(error as Error).message}` });
  }
}

export function startLotteryScheduler(client: Client): void {
  if (lotterySchedulerTimer) return;
  lotterySchedulerTimer = setInterval(async () => {
    if (lotterySchedulerBusy) return;
    lotterySchedulerBusy = true;
    try {
      const guildIds = [...client.guilds.cache.keys()];
      if (guildIds.length === 0) return;
      // Geldkritische Settlement-Arbeit darf niemals hinter alten, nicht
      // zustellbaren Ergebnis-Ankuendigungen verhungern. Deshalb werden beide
      // Workloads getrennt begrenzt und Settlement-Runden immer zuerst verarbeitet.
      const settlementRounds = await prisma.lotteryRound.findMany({
        where: {
          guildId: { in: guildIds },
          OR: [
            { status: 'ACTIVE', endsAt: { lte: new Date() } },
            { status: { in: ['DRAWING', 'REFUNDING'] } },
          ],
        },
        select: { id: true },
        orderBy: { endsAt: 'asc' },
        take: 100,
      });
      for (const round of settlementRounds) {
        try { await settleLotteryRound(client, round.id); }
        catch (error) { logger.error(`Lotterie-Scheduler Settlement ${round.id}:`, error as Error); }
      }

      const announcementRounds = await prisma.lotteryRound.findMany({
        where: {
          guildId: { in: guildIds },
          status: { in: ['FINISHED', 'REFUNDED'] },
          announcedAt: null,
        },
        select: { id: true },
        orderBy: { endsAt: 'asc' },
        take: 100,
      });
      for (const round of announcementRounds) {
        try { await settleLotteryRound(client, round.id); }
        catch (error) { logger.error(`Lotterie-Scheduler Announcement ${round.id}:`, error as Error); }
      }
    } catch (error) {
      logger.error('Lotterie-Scheduler Fehler:', error as Error);
    } finally {
      lotterySchedulerBusy = false;
    }
  }, LOTTERY_INTERVAL_MS);
  lotterySchedulerTimer.unref?.();
  logger.info('Lotterie-Scheduler gestartet.');
}

export function stopLotteryScheduler(): void {
  if (!lotterySchedulerTimer) return;
  clearInterval(lotterySchedulerTimer);
  lotterySchedulerTimer = null;
  lotterySchedulerBusy = false;
}