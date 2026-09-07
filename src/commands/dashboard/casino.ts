/**
 * Casino-Commands (6 Stueck).
 *
 * Spielt aus der Wallet des explizit aufgeloesten Gameserver-Slots.
 * Jede Datenoperation ist an guildId + nitradoConnId gebunden.
 *
 * Fairness-/Regelmodell:
 * - SLOT: konfigurierbare Gewinnchance (`winChancePct`).
 * - COINFLIP: echte 50/50-Muenze; `winChancePct` wird absichtlich nicht benutzt.
 * - DICE: echte 1-aus-6-Chance; `winChancePct` wird absichtlich nicht benutzt.
 * - BLACKJACK: Karten-/Dealerlogik; Gleichstand ist DRAW und erstattet den Einsatz.
 *
 * Neue Runden speichern einen unveraenderlichen Regel-/Payout-Snapshot im
 * result-JSON. Der Server-Seed kann nach der Runde ueber /casino-verify
 * offengelegt und gegen Seed-Hash, Nonce, Outcome und Auszahlung geprueft werden.
 * Es gibt weiterhin keinen vorgelagerten Commit/Reveal-Flow; deshalb wird dies
 * bewusst nur als Runden-Audit und nicht als "Provably Fair" bezeichnet.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import type { CasinoGameType } from '@prisma/client';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { getConfig } from '../../modules/economy/repository';
import { assertEconomyScopeReady } from '../../modules/economy/scopeMigration';
import { asUserDiscordId } from '../../types/scope';
import type { GuildScope, UserDiscordId } from '../../types/scope';
import { logAudit, logger } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { buildStatusEmbed } from '../../utils/statusEmbed';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import {
  CASINO_ALGORITHM_VERSION,
  MAX_CASINO_BET,
  assertCasinoEconomySafe,
  payoutMultiplierMilli,
} from '../../modules/economy/casinoRules';

const DISCORD_MAX_CASINO_BET = Number(MAX_CASINO_BET);
const SIGNED_BIGINT_MASK = (1n << 63n) - 1n;

function fmt(n: bigint): string { return n.toLocaleString('de-DE'); }

function slotOption(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addIntegerOption(o => o
    .setName('slot')
    .setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)')
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(MAX_GAME_SERVERS_PER_GUILD)) as SlashCommandBuilder;
}

function betOption(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addIntegerOption(o => o
    .setName('einsatz')
    .setDescription('Einsatz')
    .setRequired(true)
    .setMinValue(1)
    .setMaxValue(DISCORD_MAX_CASINO_BET)) as SlashCommandBuilder;
}

type RawDb = {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
};

interface CasinoGameDbRow {
  id: string;
  enabled: boolean;
  winChancePct: number;
  minBet: bigint;
  maxBet: bigint;
  payoutMult: number;
}

interface CasinoUserStatsRow {
  rounds: bigint;
  wins: bigint;
  draws: bigint;
  bet: bigint;
  payout: bigint;
}

interface CasinoVerifyDbRow {
  id: string;
  type: CasinoGameType;
  bet: bigint;
  payout: bigint;
  result: unknown;
  serverSeed: string;
  clientSeed: string | null;
  nonce: bigint;
  createdAt: Date;
}

interface CasinoAuditSnapshot {
  algorithmVersion: string;
  type: CasinoGameType;
  winChancePct: number | null;
  payoutMultMilli: number;
  minBet: string;
  maxBet: string;
  serverSeedHash: string;
}

class CasinoUserError extends Error {}

async function queryOne<T>(db: RawDb, sql: string, ...values: unknown[]): Promise<T | null> {
  const rows = await db.$queryRawUnsafe<T[]>(sql, ...values);
  return rows[0] ?? null;
}

async function statusFail(i: ChatInputCommandInteraction, e: unknown): Promise<void> {
  const safeMessage = e instanceof CasinoUserError
    ? e.message
    : 'Interner Casino-Fehler. Die Runde wurde vollstaendig zurueckgerollt.';
  if (!(e instanceof CasinoUserError)) {
    logger.error('Casino runtime failure', {
      guildId: i.guildId,
      userDiscordId: i.user.id,
      command: i.commandName,
      error: e instanceof Error ? e.message : String(e),
    });
  }
  const embed = buildStatusEmbed({
    status: 'ERROR',
    title: 'Spiel nicht gestartet',
    description: 'Die Runde konnte nicht gestartet werden.',
    fields: [{ name: '📝 Grund', value: safeMessage }],
    footerText: 'V-Bot Casino',
  });
  await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
}

type RoundOutcome = 'WON' | 'LOST' | 'DRAW';

function buildRoundEmbed(args: {
  i: ChatInputCommandInteraction;
  title: string;
  emoji: string;
  outcome: RoundOutcome;
  bet: bigint;
  payout: bigint;
  coin: string;
  details: { name: string; value: string; inline?: boolean }[];
  roundId: string;
  serverSeedHash: string;
  nonce: bigint;
}): EmbedBuilder {
  const net = args.payout - args.bet;
  const netStr = (net >= 0n ? '+' : '') + fmt(net);
  const meta = args.outcome === 'WON'
    ? { sym: '✅', word: 'Gewonnen', color: Colors.Success }
    : args.outcome === 'DRAW'
      ? { sym: '⚠️', word: 'Unentschieden', color: Colors.Warning }
      : { sym: '❌', word: 'Verloren', color: Colors.Error };
  const netField = args.outcome === 'WON'
    ? { name: '📈 Gewinn', value: `${netStr} ${args.coin}`, inline: false }
    : args.outcome === 'DRAW'
      ? { name: '📊 Netto', value: `${netStr} ${args.coin}`, inline: false }
      : { name: '📉 Verlust', value: `${netStr} ${args.coin}`, inline: false };

  return vEmbed(meta.color)
    .setAuthor({ name: args.i.user.username, iconURL: args.i.user.displayAvatarURL() })
    .setTitle(`${args.emoji} ${args.title}`)
    .setDescription(`${meta.sym} **${meta.word}**`)
    .addFields(
      { name: '💰 Einsatz', value: `${fmt(args.bet)} ${args.coin}`, inline: false },
      { name: '🏆 Auszahlung', value: `${fmt(args.payout)} ${args.coin}`, inline: false },
      netField,
      ...args.details,
      { name: '🔎 Audit', value: `Runde \`${args.roundId}\`\nMit \`/casino-verify\` nachpruefbar.`, inline: false },
    )
    .setFooter({ text: `V-Bot Casino • Runden-Audit • Hash: ${args.serverSeedHash} • Nonce: ${args.nonce.toString()}` })
    .setTimestamp();
}

function seedHashFull(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

function seedHash(seed: string): string {
  return seedHashFull(seed).slice(0, 16);
}

/** Deterministische HMAC-Zufallszahl ohne Modulo-Bias. */
function roll(serverSeed: string, clientSeed: string, nonce: bigint, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1) throw new Error('Ungueltiger Zufallsbereich.');
  const max = BigInt(maxExclusive);
  const range = 1n << 64n;
  const limit = range - (range % max);
  for (let attempt = 0; attempt < 16; attempt++) {
    const digest = createHmac('sha256', serverSeed)
      .update(`${clientSeed}:${nonce.toString()}:${attempt}`)
      .digest();
    const value = digest.readBigUInt64BE(0);
    if (value < limit) return Number(value % max);
  }
  throw new Error('Zufallszahl konnte nicht bias-frei erzeugt werden.');
}

function randomNonce(): bigint {
  return randomBytes(8).readBigUInt64BE(0) & SIGNED_BIGINT_MASK;
}

interface PlayResult {
  won: boolean;
  draw: boolean;
  payout: bigint;
  details: Record<string, unknown>;
}

interface RuntimeGameConfig {
  winChancePct: number;
  payoutMultMilli: number;
}

function outcomeOf(result: PlayResult): RoundOutcome {
  if (result.draw) return 'DRAW';
  return result.won ? 'WON' : 'LOST';
}

function isStoredDraw(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && (value as Record<string, unknown>).draw === true;
}

function isStoredWin(value: unknown, payout: bigint): boolean {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const won = (value as Record<string, unknown>).won;
    if (typeof won === 'boolean') return won;
  }
  return payout > 0n;
}

function safePayout(bet: bigint, multiplierMilli: number): bigint {
  if (!Number.isInteger(multiplierMilli) || multiplierMilli < 0) throw new Error('Ungueltiger Auszahlungs-Multiplikator.');
  return (bet * BigInt(multiplierMilli)) / 1000n;
}

function blackjackScore(cards: number[]): number {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card === 1) {
      total += 11;
      aces++;
    } else {
      total += Math.min(card, 10);
    }
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces--;
  }
  return total;
}

function resolveGame(
  type: CasinoGameType,
  bet: bigint,
  clientSeed: string,
  game: RuntimeGameConfig,
  serverSeed: string,
  nonce: bigint,
): PlayResult {
  if (type === 'SLOT') {
    const won = roll(serverSeed, clientSeed, nonce, 100) < game.winChancePct;
    return { won, draw: false, payout: won ? safePayout(bet, game.payoutMultMilli) : 0n, details: { game: 'SLOT' } };
  }
  if (type === 'COINFLIP') {
    if (clientSeed !== 'KOPF' && clientSeed !== 'ZAHL') throw new Error('Ungueltiger Coinflip-ClientSeed.');
    const flip = roll(serverSeed, clientSeed, nonce, 2) === 0 ? 'KOPF' : 'ZAHL';
    const won = flip === clientSeed;
    return { won, draw: false, payout: won ? safePayout(bet, game.payoutMultMilli) : 0n, details: { flip, choice: clientSeed } };
  }
  if (type === 'DICE') {
    const tip = Number(clientSeed);
    if (!Number.isInteger(tip) || tip < 1 || tip > 6) throw new Error('Ungueltiger Dice-ClientSeed.');
    const rolled = roll(serverSeed, clientSeed, nonce, 6) + 1;
    const won = rolled === tip;
    return { won, draw: false, payout: won ? safePayout(bet, game.payoutMultMilli) : 0n, details: { rolled, tip } };
  }

  const drawCard = (k: number) => roll(serverSeed, `card:${k}`, nonce, 13) + 1;
  const player = [drawCard(0), drawCard(2)];
  const dealer = [drawCard(1), drawCard(3)];
  let k = 4;
  while (blackjackScore(player) < 17 && k <= 20) player.push(drawCard(k++));
  while (blackjackScore(dealer) < 17 && k <= 40) dealer.push(drawCard(k++));

  const ps = blackjackScore(player);
  const ds = blackjackScore(dealer);
  const playerBust = ps > 21;
  const dealerBust = ds > 21;
  const draw = !playerBust && !dealerBust && ps === ds;
  const won = !draw && !playerBust && (dealerBust || ps > ds);
  const payout = draw ? bet : won ? safePayout(bet, game.payoutMultMilli) : 0n;
  return { won, draw, payout, details: { player, dealer, ps, ds } };
}

function auditSnapshot(value: unknown): CasinoAuditSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const audit = (value as Record<string, unknown>).audit;
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return null;
  const row = audit as Record<string, unknown>;
  const type = row.type;
  if (type !== 'SLOT' && type !== 'COINFLIP' && type !== 'DICE' && type !== 'BLACKJACK') return null;
  if (typeof row.algorithmVersion !== 'string'
    || (typeof row.winChancePct !== 'number' && row.winChancePct !== null)
    || typeof row.payoutMultMilli !== 'number'
    || typeof row.minBet !== 'string'
    || typeof row.maxBet !== 'string'
    || typeof row.serverSeedHash !== 'string') return null;
  return {
    algorithmVersion: row.algorithmVersion,
    type,
    winChancePct: row.winChancePct,
    payoutMultMilli: row.payoutMultMilli,
    minBet: row.minBet,
    maxBet: row.maxBet,
    serverSeedHash: row.serverSeedHash,
  };
}

/** Atomare, servergescopte Bet-Verbuchung + Round-Insert. */
async function playRound(args: {
  scope: GuildScope;
  type: CasinoGameType;
  bet: bigint;
  clientSeed: string;
}): Promise<{ result: PlayResult; serverSeed: string; nonce: bigint; gameRowId: string; roundId: string }> {
  const nitradoConnId = args.scope.nitradoConnId;
  if (!nitradoConnId) throw new CasinoUserError('Kein Gameserver-Scope fuer Casino aufgeloest.');
  await assertEconomyScopeReady(args.scope.guildId, nitradoConnId);

  const db = prisma as unknown as RawDb;
  const game = await queryOne<CasinoGameDbRow>(
    db,
    'SELECT "id", "enabled", "winChancePct", "minBet", "maxBet", "payoutMult" FROM "CasinoGame" WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "type" = $3::"CasinoGameType" LIMIT 1',
    String(args.scope.guildId), String(nitradoConnId), args.type,
  );
  if (!game || !game.enabled) throw new CasinoUserError('Spiel ist deaktiviert.');
  if (args.bet < game.minBet) throw new CasinoUserError(`Mindesteinsatz: ${fmt(game.minBet)}`);
  if (args.bet > game.maxBet) throw new CasinoUserError(`Hoechsteinsatz: ${fmt(game.maxBet)}`);
  try {
    assertCasinoEconomySafe(args.type, game.winChancePct, game.payoutMult);
  } catch {
    throw new CasinoUserError('Spiel wurde wegen einer unsicheren Auszahlungs-Konfiguration gesperrt.');
  }

  const serverSeed = randomBytes(32).toString('hex');
  const nonce = randomNonce();
  const roundId = randomUUID();
  const payoutMultMilli = payoutMultiplierMilli(game.payoutMult);
  const runtimeGame = { winChancePct: game.winChancePct, payoutMultMilli };
  const result = resolveGame(args.type, args.bet, args.clientSeed, runtimeGame, serverSeed, nonce);
  const storedResult = {
    ...result,
    audit: {
      algorithmVersion: CASINO_ALGORITHM_VERSION,
      type: args.type,
      winChancePct: args.type === 'SLOT' ? game.winChancePct : null,
      payoutMultMilli,
      minBet: game.minBet.toString(),
      maxBet: game.maxBet.toString(),
      serverSeedHash: seedHashFull(serverSeed),
    } satisfies CasinoAuditSnapshot,
  };

  return prisma.$transaction(async tx => {
    const tdb = tx as unknown as RawDb;
    const updated = await tdb.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "walletBalance" = "walletBalance" - $4, "lifetimeSpent" = "lifetimeSpent" + $4, "updatedAt" = CURRENT_TIMESTAMP WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "userDiscordId" = $3 AND "walletBalance" >= $4',
      String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId), args.bet,
    );
    if (updated !== 1) throw new CasinoUserError('Unzureichendes Guthaben.');

    await tdb.$executeRawUnsafe(
      'INSERT INTO "EconomyTransaction" ("id", "guildId", "nitradoConnId", "userDiscordId", "delta", "type", "reason", "actorDiscordId", "counterpartDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,NULL,CURRENT_TIMESTAMP)',
      randomUUID(), String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
      -args.bet, 'CASINO_BET', args.type, String(args.scope.actorDiscordId),
    );

    if (result.payout > 0n) {
      const paid = await tdb.$executeRawUnsafe(
        'UPDATE "EconomyAccount" SET "walletBalance" = "walletBalance" + $4, "lifetimeEarned" = "lifetimeEarned" + $4, "updatedAt" = CURRENT_TIMESTAMP WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "userDiscordId" = $3',
        String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId), result.payout,
      );
      if (paid !== 1) throw new Error('Casino-Auszahlung konnte keinem Serverkonto zugeordnet werden.');
      await tdb.$executeRawUnsafe(
        'INSERT INTO "EconomyTransaction" ("id", "guildId", "nitradoConnId", "userDiscordId", "delta", "type", "reason", "actorDiscordId", "counterpartDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,NULL,CURRENT_TIMESTAMP)',
        randomUUID(), String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
        result.payout, 'CASINO_PAYOUT', result.draw ? `${args.type}:DRAW_REFUND` : args.type, String(args.scope.actorDiscordId),
      );
    }

    await tdb.$executeRawUnsafe(
      'INSERT INTO "CasinoRound" ("id", "gameId", "guildId", "nitradoConnId", "userDiscordId", "bet", "payout", "result", "serverSeed", "clientSeed", "nonce", "createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,CURRENT_TIMESTAMP)',
      roundId, game.id, String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
      args.bet, result.payout, JSON.stringify(storedResult, (_key, value) => typeof value === 'bigint' ? value.toString() : value), serverSeed, args.clientSeed, nonce,
    );

    return { result, serverSeed, nonce, gameRowId: game.id, roundId };
  });
}

export const slotCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder()
    .setName('slot')
    .setDescription('Slot-Maschine: Gewinnchance & Payout aus Casino-Config.'))),
  cooldown: 2,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({ scope, type: 'SLOT', bet, clientSeed: 'slot' });
    } catch (e) { await statusFail(i, e); return; }
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId!);
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, gameType: 'SLOT', payout: out.result.payout.toString() } });
    const embed = buildRoundEmbed({
      i, title: 'Slot-Maschine', emoji: '🎰', outcome: outcomeOf(out.result),
      bet, payout: out.result.payout, coin: cfg.emoji, details: [], roundId: out.roundId,
      serverSeedHash: seedHash(out.serverSeed), nonce: out.nonce,
    });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const coinflipCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Wirft eine echte 50/50-Muenze. Richtige Wahl gewinnt.')
    .addStringOption(o => o.setName('seite').setDescription('Kopf oder Zahl').setRequired(true).addChoices(
      { name: 'Kopf', value: 'KOPF' }, { name: 'Zahl', value: 'ZAHL' },
    )))),
  cooldown: 2,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const choice = i.options.getString('seite', true) as 'KOPF' | 'ZAHL';
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({ scope, type: 'COINFLIP', bet, clientSeed: choice });
    } catch (e) { await statusFail(i, e); return; }
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId!);
    const flip = (out.result.details as { flip: string }).flip;
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, gameType: 'COINFLIP', payout: out.result.payout.toString() } });
    const embed = buildRoundEmbed({
      i, title: 'Coinflip', emoji: '🪙', outcome: outcomeOf(out.result),
      bet, payout: out.result.payout, coin: cfg.emoji,
      details: [
        { name: '🎯 Deine Wahl', value: choice === 'KOPF' ? 'Kopf' : 'Zahl', inline: false },
        { name: '🪙 Ergebnis', value: flip === 'KOPF' ? 'Kopf' : 'Zahl', inline: false },
      ],
      roundId: out.roundId, serverSeedHash: seedHash(out.serverSeed), nonce: out.nonce,
    });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const diceCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Wuerfelt 1..6. Exakter Treffer gewinnt.')
    .addIntegerOption(o => o.setName('zahl').setDescription('Tippe 1..6').setRequired(true).setMinValue(1).setMaxValue(6)))),
  cooldown: 2,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const tip = i.options.getInteger('zahl', true);
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({ scope, type: 'DICE', bet, clientSeed: String(tip) });
    } catch (e) { await statusFail(i, e); return; }
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId!);
    const rolled = (out.result.details as { rolled: number }).rolled;
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, gameType: 'DICE', payout: out.result.payout.toString() } });
    const embed = buildRoundEmbed({
      i, title: 'Wuerfel', emoji: '🎲', outcome: outcomeOf(out.result),
      bet, payout: out.result.payout, coin: cfg.emoji,
      details: [
        { name: '🎯 Dein Tipp', value: String(tip), inline: false },
        { name: '🎲 Gewuerfelt', value: String(rolled), inline: false },
      ],
      roundId: out.roundId, serverSeedHash: seedHash(out.serverSeed), nonce: out.nonce,
    });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const blackjackCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Vereinfachtes Blackjack: bis 17 ziehen, naeher an 21 gewinnt; Gleichstand = Einsatz zurueck.'))),
  cooldown: 2,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({ scope, type: 'BLACKJACK', bet, clientSeed: 'blackjack' });
    } catch (e) { await statusFail(i, e); return; }
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId!);
    const d = out.result.details as { player: number[]; dealer: number[]; ps: number; ds: number };
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, gameType: 'BLACKJACK', payout: out.result.payout.toString(), outcome: outcomeOf(out.result) } });
    const embed = buildRoundEmbed({
      i, title: 'Blackjack', emoji: '🃏', outcome: outcomeOf(out.result),
      bet, payout: out.result.payout, coin: cfg.emoji,
      details: [
        { name: '🧍 Deine Karten', value: d.player.join(', '), inline: false },
        { name: '📊 Dein Wert', value: String(d.ps), inline: false },
        { name: '🎩 Dealer-Karten', value: d.dealer.join(', '), inline: false },
        { name: '📊 Dealer-Wert', value: String(d.ds), inline: false },
      ],
      roundId: out.roundId, serverSeedHash: seedHash(out.serverSeed), nonce: out.nonce,
    });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const casinoStatsCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('casino-stats')
    .setDescription('Zeigt Casino-Statistik fuer dich oder einen anderen User.')
    .addUserOption(o => o.setName('user').setDescription('Optional anderer User').setRequired(false)) as SlashCommandBuilder),
  cooldown: 3,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user') ?? i.user;
    const targetId: UserDiscordId = asUserDiscordId(target.id);
    if (!scope.nitradoConnId) throw new Error('Kein Gameserver-Scope fuer Casino aufgeloest.');
    await assertEconomyScopeReady(scope.guildId, scope.nitradoConnId);
    const row = await queryOne<CasinoUserStatsRow>(
      prisma as unknown as RawDb,
      `SELECT COUNT(*)::bigint AS "rounds",
              COUNT(*) FILTER (WHERE "result"->>'draw' = 'true')::bigint AS "draws",
              COUNT(*) FILTER (
                WHERE COALESCE("result"->>'draw', 'false') <> 'true'
                  AND CASE WHEN "result" ? 'won' THEN "result"->>'won' = 'true' ELSE "payout" > 0 END
              )::bigint AS "wins",
              COALESCE(SUM("bet"), 0)::bigint AS "bet",
              COALESCE(SUM("payout"), 0)::bigint AS "payout"
         FROM "CasinoRound"
        WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "userDiscordId" = $3`,
      String(scope.guildId), String(scope.nitradoConnId), String(targetId),
    );
    const rounds = row?.rounds ?? 0n;
    if (rounds === 0n) {
      const empty = buildStatusEmbed({
        status: 'INFO',
        title: 'Casino-Statistik',
        description: `Fuer ${target.username} liegt noch keine Casino-Aktivitaet vor.`,
        footerText: 'V-Bot Casino',
      });
      await i.reply({ embeds: [empty], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    const wins = row?.wins ?? 0n;
    const draws = row?.draws ?? 0n;
    const losses = rounds - wins - draws;
    const bet = row?.bet ?? 0n;
    const payout = row?.payout ?? 0n;
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId);
    const net = payout - bet;
    const netStr = (net >= 0n ? '+' : '') + fmt(net);
    const winRate = Number((wins * 10_000n) / rounds) / 100;
    const e = vEmbed(net >= 0n ? Colors.Success : Colors.Error)
      .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
      .setTitle('📊 Casino-Statistik')
      .addFields(
        { name: '🎲 Runden', value: rounds.toString(), inline: false },
        { name: '🏆 Siege', value: wins.toString(), inline: true },
        { name: '⚠️ Unentschieden', value: draws.toString(), inline: true },
        { name: '❌ Niederlagen', value: losses.toString(), inline: true },
        { name: '🏆 Win-Rate', value: `${winRate.toFixed(2)}%`, inline: false },
        { name: '💰 Einsatz gesamt', value: `${fmt(bet)} ${cfg.emoji}`, inline: false },
        { name: '🏆 Auszahlung gesamt', value: `${fmt(payout)} ${cfg.emoji}`, inline: false },
        { name: '📊 Netto', value: `${netStr} ${cfg.emoji}`, inline: false },
      )
      .setFooter({ text: 'V-Bot Casino' })
      .setTimestamp();
    await i.reply({ embeds: [e], flags: target.id === i.user.id ? MessageFlags.Ephemeral : undefined, allowedMentions: { parse: [] } });
    logAudit('CASINO_STATS', 'CASINO', {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      target: target.id,
      rounds: rounds.toString(),
      wins: wins.toString(),
      draws: draws.toString(),
      losses: losses.toString(),
    });
  }),
};

export const casinoVerifyCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('casino-verify')
    .setDescription('Prueft Seed, Nonce, Regel-Snapshot und Auszahlung einer eigenen Casino-Runde.')
    .addStringOption(o => o.setName('runde').setDescription('Runden-ID aus dem Casino-Embed').setRequired(true).setMinLength(1).setMaxLength(128)) as SlashCommandBuilder),
  cooldown: 3,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    if (!scope.nitradoConnId) throw new Error('Kein Gameserver-Scope fuer Casino aufgeloest.');
    await assertEconomyScopeReady(scope.guildId, scope.nitradoConnId);
    const roundId = i.options.getString('runde', true).trim();
    const round = await queryOne<CasinoVerifyDbRow>(
      prisma as unknown as RawDb,
      `SELECT r."id", g."type"::text AS "type", r."bet", r."payout", r."result",
              r."serverSeed", r."clientSeed", r."nonce", r."createdAt"
         FROM "CasinoRound" r
         JOIN "CasinoGame" g
           ON g."id" = r."gameId"
          AND g."guildId" = r."guildId"
          AND g."nitradoConnId" = r."nitradoConnId"
        WHERE r."id" = $1 AND r."guildId" = $2 AND r."nitradoConnId" = $3 AND r."userDiscordId" = $4
        LIMIT 1`,
      roundId, String(scope.guildId), String(scope.nitradoConnId), String(scope.actorDiscordId),
    );
    if (!round) {
      const missing = buildStatusEmbed({
        status: 'ERROR', title: 'Runde nicht gefunden',
        description: 'Die Runde existiert in diesem Gameserver-Slot nicht oder gehoert nicht dir.',
        footerText: 'V-Bot Casino Audit',
      });
      await i.reply({ embeds: [missing], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    const snapshot = auditSnapshot(round.result);
    if (!snapshot || snapshot.algorithmVersion !== CASINO_ALGORITHM_VERSION) {
      const legacy = buildStatusEmbed({
        status: 'WARNING', title: 'Legacy-Runde',
        description: 'Diese Runde besitzt noch keinen vollstaendigen unveraenderlichen Regel-Snapshot und kann deshalb nicht kryptographisch vollstaendig nachgerechnet werden.',
        fields: [
          { name: 'Runde', value: `\`${round.id}\`` },
          { name: 'Seed-Hash', value: `\`${seedHashFull(round.serverSeed)}\`` },
        ],
        footerText: 'V-Bot Casino Audit',
      });
      await i.reply({ embeds: [legacy], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    const clientSeed = round.clientSeed ?? (round.type === 'SLOT' ? 'slot' : round.type === 'BLACKJACK' ? 'blackjack' : '');
    let replay: PlayResult;
    try {
      replay = resolveGame(
        round.type,
        round.bet,
        clientSeed,
        { winChancePct: snapshot.winChancePct ?? 0, payoutMultMilli: snapshot.payoutMultMilli },
        round.serverSeed,
        round.nonce,
      );
    } catch (error) {
      logger.error('Casino verify replay failed', { guildId: scope.guildId, roundId: round.id, error: error instanceof Error ? error.message : String(error) });
      const failed = buildStatusEmbed({
        status: 'ERROR', title: 'Audit fehlgeschlagen',
        description: 'Die gespeicherte Runde konnte mit ihrem Audit-Snapshot nicht reproduziert werden.',
        footerText: 'V-Bot Casino Audit',
      });
      await i.reply({ embeds: [failed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    const storedDraw = isStoredDraw(round.result);
    const storedWin = isStoredWin(round.result, round.payout);
    const hashMatches = seedHashFull(round.serverSeed) === snapshot.serverSeedHash;
    const payoutMatches = replay.payout === round.payout;
    const outcomeMatches = replay.draw === storedDraw && replay.won === storedWin;
    const verified = hashMatches && payoutMatches && outcomeMatches && snapshot.type === round.type;
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId);
    const embed = vEmbed(verified ? Colors.Success : Colors.Error)
      .setTitle(verified ? '✅ Casino-Runde verifiziert' : '❌ Casino-Runde NICHT verifiziert')
      .setDescription(verified
        ? 'Seed, Nonce, Regel-Snapshot, Outcome und Auszahlung sind reproduzierbar.'
        : 'Mindestens ein gespeicherter Audit-Wert stimmt nicht mit der reproduzierten Runde ueberein.')
      .addFields(
        { name: '🎲 Spiel', value: round.type, inline: true },
        { name: '💰 Einsatz', value: `${fmt(round.bet)} ${cfg.emoji}`, inline: true },
        { name: '🏆 Auszahlung', value: `${fmt(round.payout)} ${cfg.emoji}`, inline: true },
        { name: '🧩 Algorithmus', value: snapshot.algorithmVersion, inline: false },
        { name: '🔑 Server-Seed', value: `\`${round.serverSeed}\``, inline: false },
        { name: '🧑 Client-Seed', value: `\`${clientSeed}\``, inline: false },
        { name: '#️⃣ Nonce', value: round.nonce.toString(), inline: false },
        { name: '🔐 SHA-256', value: `\`${seedHashFull(round.serverSeed)}\``, inline: false },
        { name: '⚙️ Snapshot', value: `Payout x${(snapshot.payoutMultMilli / 1000).toFixed(3)} • Min ${snapshot.minBet} • Max ${snapshot.maxBet}${round.type === 'SLOT' ? ` • Win ${snapshot.winChancePct}%` : ''}`, inline: false },
      )
      .setFooter({ text: `V-Bot Casino Audit • Runde ${round.id}` })
      .setTimestamp(round.createdAt);
    await i.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    logAudit('CASINO_VERIFY', 'CASINO', {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      roundId: round.id,
      verified,
      hashMatches,
      payoutMatches,
      outcomeMatches,
    });
  }),
};
