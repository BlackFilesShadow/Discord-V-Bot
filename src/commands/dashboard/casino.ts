/**
 * Casino-Commands (5 Stueck).
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
 * Der gespeicherte Server-Seed + Nonce erlaubt einen technischen Runden-Audit.
 * Es gibt derzeit jedoch keinen vorgelagerten Commit/Reveal-Flow; deshalb wird
 * dies in der UI nicht als "Provably Fair" bezeichnet.
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
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { Colors } from '../../utils/embedDesign';
import { buildStatusEmbed } from '../../utils/statusEmbed';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';

function fmt(n: bigint): string { return n.toLocaleString('de-DE'); }

function slotOption(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addIntegerOption(o => o
    .setName('slot')
    .setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)')
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(MAX_GAME_SERVERS_PER_GUILD)) as SlashCommandBuilder;
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

interface CasinoRoundStatsRow {
  bet: bigint;
  payout: bigint;
  gameId: string;
  result: unknown;
}

async function queryOne<T>(db: RawDb, sql: string, ...values: unknown[]): Promise<T | null> {
  const rows = await db.$queryRawUnsafe<T[]>(sql, ...values);
  return rows[0] ?? null;
}

async function statusFail(i: ChatInputCommandInteraction, e: unknown): Promise<void> {
  const embed = buildStatusEmbed({
    status: 'ERROR',
    title: 'Spiel nicht gestartet',
    description: 'Die Runde konnte nicht gestartet werden.',
    fields: [{ name: '📝 Grund', value: e instanceof Error ? e.message : 'Unbekannter Fehler.' }],
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

  return new EmbedBuilder()
    .setColor(meta.color)
    .setAuthor({ name: args.i.user.username, iconURL: args.i.user.displayAvatarURL() })
    .setTitle(`${args.emoji} ${args.title}`)
    .setDescription(`${meta.sym} **${meta.word}**`)
    .addFields(
      { name: '💰 Einsatz', value: `${fmt(args.bet)} ${args.coin}`, inline: false },
      { name: '🏆 Auszahlung', value: `${fmt(args.payout)} ${args.coin}`, inline: false },
      netField,
      ...args.details,
    )
    .setFooter({ text: `V-Bot Casino • Runden-Audit • Hash: ${args.serverSeedHash} • Nonce: ${args.nonce.toString()}` })
    .setTimestamp();
}

function seedHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function roll(serverSeed: string, clientSeed: string, nonce: bigint, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1) throw new Error('Ungueltiger Zufallsbereich.');
  const h = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce.toString()}`).digest('hex');
  const slice = h.slice(0, 13);
  const v = Number.parseInt(slice, 16);
  return v % maxExclusive;
}

interface PlayResult {
  won: boolean;
  draw: boolean;
  payout: bigint;
  details: Record<string, unknown>;
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
  // Legacy-Runden hatten kein explizites draw-Feld.
  return payout > 0n;
}

function safePayout(bet: bigint, multiplier: number): bigint {
  if (!Number.isFinite(multiplier) || multiplier < 0) throw new Error('Ungueltiger Auszahlungs-Multiplikator.');
  const scaled = Math.round(multiplier * 1000);
  return (bet * BigInt(scaled)) / 1000n;
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

/** Atomare, servergescopte Bet-Verbuchung + Round-Insert. */
async function playRound(args: {
  scope: GuildScope;
  type: CasinoGameType;
  bet: bigint;
  clientSeed: string | null;
  decide: (game: { winChancePct: number; payoutMult: number }, serverSeed: string, nonce: bigint) => PlayResult;
}): Promise<{ result: PlayResult; serverSeed: string; nonce: bigint; gameRowId: string }> {
  const nitradoConnId = args.scope.nitradoConnId;
  if (!nitradoConnId) throw new Error('Kein Gameserver-Scope fuer Casino aufgeloest.');
  await assertEconomyScopeReady(args.scope.guildId, nitradoConnId);

  const db = prisma as unknown as RawDb;
  const game = await queryOne<CasinoGameDbRow>(
    db,
    'SELECT "id", "enabled", "winChancePct", "minBet", "maxBet", "payoutMult" FROM "CasinoGame" WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "type" = $3::"CasinoGameType" LIMIT 1',
    String(args.scope.guildId), String(nitradoConnId), args.type,
  );
  if (!game || !game.enabled) throw new Error('Spiel ist deaktiviert.');
  if (args.bet < game.minBet) throw new Error(`Mindesteinsatz: ${fmt(game.minBet)}`);
  if (args.bet > game.maxBet) throw new Error(`Hoechsteinsatz: ${fmt(game.maxBet)}`);

  const serverSeed = randomBytes(32).toString('hex');

  return prisma.$transaction(async tx => {
    const tdb = tx as unknown as RawDb;
    const updated = await tdb.$executeRawUnsafe(
      'UPDATE "EconomyAccount" SET "walletBalance" = "walletBalance" - $4, "lifetimeSpent" = "lifetimeSpent" + $4, "updatedAt" = CURRENT_TIMESTAMP WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "userDiscordId" = $3 AND "walletBalance" >= $4',
      String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId), args.bet,
    );
    if (updated !== 1) throw new Error('Unzureichendes Guthaben.');

    await tdb.$executeRawUnsafe(
      'INSERT INTO "EconomyTransaction" ("id", "guildId", "nitradoConnId", "userDiscordId", "delta", "type", "reason", "actorDiscordId", "counterpartDiscordId", "createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,NULL,CURRENT_TIMESTAMP)',
      randomUUID(), String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
      -args.bet, 'CASINO_BET', args.type, String(args.scope.actorDiscordId),
    );

    const countRow = await queryOne<{ count: bigint }>(
      tdb,
      'SELECT COUNT(*)::bigint AS "count" FROM "CasinoRound" WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "gameId" = $3 AND "userDiscordId" = $4',
      String(args.scope.guildId), String(nitradoConnId), game.id, String(args.scope.actorDiscordId),
    );
    const nonce = countRow?.count ?? 0n;
    const result = args.decide({ winChancePct: game.winChancePct, payoutMult: game.payoutMult }, serverSeed, nonce);

    // Auch ein DRAW kann eine Auszahlung (Einsatz-Rueckgabe) haben.
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
      randomUUID(), game.id, String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
      args.bet, result.payout, JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value), serverSeed, args.clientSeed, nonce,
    );

    return { result, serverSeed, nonce, gameRowId: game.id };
  });
}

export const slotCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('slot')
    .setDescription('Slot-Maschine: Gewinnchance & Payout aus Casino-Config.')
    .addIntegerOption(o => o.setName('einsatz').setDescription('Einsatz').setRequired(true).setMinValue(1).setMaxValue(1_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({
        scope, type: 'SLOT', bet, clientSeed: null,
        decide: (g, s, n) => {
          const won = roll(s, 'slot', n, 100) < g.winChancePct;
          return { won, draw: false, payout: won ? safePayout(bet, g.payoutMult) : 0n, details: { game: 'SLOT' } };
        },
      });
    } catch (e) { await statusFail(i, e); return; }
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId!);
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, gameType: 'SLOT', payout: out.result.payout.toString() } });
    const embed = buildRoundEmbed({
      i, title: 'Slot-Maschine', emoji: '🎰', outcome: outcomeOf(out.result),
      bet, payout: out.result.payout, coin: cfg.emoji, details: [],
      serverSeedHash: seedHash(out.serverSeed), nonce: out.nonce,
    });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const coinflipCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Wirft eine echte 50/50-Muenze. Richtige Wahl gewinnt.')
    .addStringOption(o => o.setName('seite').setDescription('Kopf oder Zahl').setRequired(true).addChoices(
      { name: 'Kopf', value: 'KOPF' }, { name: 'Zahl', value: 'ZAHL' },
    ))
    .addIntegerOption(o => o.setName('einsatz').setDescription('Einsatz').setRequired(true).setMinValue(1).setMaxValue(1_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const choice = i.options.getString('seite', true) as 'KOPF' | 'ZAHL';
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({
        scope, type: 'COINFLIP', bet, clientSeed: choice,
        decide: (g, s, n) => {
          const flip = roll(s, choice, n, 2) === 0 ? 'KOPF' : 'ZAHL';
          const won = flip === choice;
          return { won, draw: false, payout: won ? safePayout(bet, g.payoutMult) : 0n, details: { flip, choice } };
        },
      });
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
      serverSeedHash: seedHash(out.serverSeed), nonce: out.nonce,
    });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const diceCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Wuerfelt 1..6. Exakter Treffer gewinnt.')
    .addIntegerOption(o => o.setName('zahl').setDescription('Tippe 1..6').setRequired(true).setMinValue(1).setMaxValue(6))
    .addIntegerOption(o => o.setName('einsatz').setDescription('Einsatz').setRequired(true).setMinValue(1).setMaxValue(1_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const tip = i.options.getInteger('zahl', true);
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({
        scope, type: 'DICE', bet, clientSeed: String(tip),
        decide: (g, s, n) => {
          const rolled = roll(s, String(tip), n, 6) + 1;
          const won = rolled === tip;
          return { won, draw: false, payout: won ? safePayout(bet, g.payoutMult) : 0n, details: { rolled, tip } };
        },
      });
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
      serverSeedHash: seedHash(out.serverSeed), nonce: out.nonce,
    });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const blackjackCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Vereinfachtes Blackjack: bis 17 ziehen, naeher an 21 gewinnt; Gleichstand = Einsatz zurueck.')
    .addIntegerOption(o => o.setName('einsatz').setDescription('Einsatz').setRequired(true).setMinValue(1).setMaxValue(1_000_000)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({
        scope, type: 'BLACKJACK', bet, clientSeed: 'blackjack',
        decide: (g, s, n) => {
          const drawCard = (k: number) => roll(s, `card:${k}`, n, 13) + 1;
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
          const payout = draw ? bet : won ? safePayout(bet, g.payoutMult) : 0n;
          return { won, draw, payout, details: { player, dealer, ps, ds } };
        },
      });
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
      serverSeedHash: seedHash(out.serverSeed), nonce: out.nonce,
    });
    await i.reply({ embeds: [embed], allowedMentions: { parse: [] } });
  }),
};

export const casinoStatsCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('casino-stats')
    .setDescription('Zeigt Casino-Statistik fuer dich oder einen anderen User.')
    .addUserOption(o => o.setName('user').setDescription('Optional anderer User').setRequired(false)) as SlashCommandBuilder),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user') ?? i.user;
    const targetId: UserDiscordId = asUserDiscordId(target.id);
    if (!scope.nitradoConnId) throw new Error('Kein Gameserver-Scope fuer Casino aufgeloest.');
    await assertEconomyScopeReady(scope.guildId, scope.nitradoConnId);
    const rows = await (prisma as unknown as RawDb).$queryRawUnsafe<CasinoRoundStatsRow[]>(
      'SELECT "bet", "payout", "gameId", "result" FROM "CasinoRound" WHERE "guildId" = $1 AND "nitradoConnId" = $2 AND "userDiscordId" = $3 ORDER BY "createdAt" DESC',
      String(scope.guildId), String(scope.nitradoConnId), String(targetId),
    );
    if (rows.length === 0) {
      const empty = buildStatusEmbed({
        status: 'INFO',
        title: 'Casino-Statistik',
        description: `Fuer ${target.username} liegt noch keine Casino-Aktivitaet vor.`,
        footerText: 'V-Bot Casino',
      });
      await i.reply({ embeds: [empty], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
      return;
    }

    let bet = 0n, payout = 0n, wins = 0, draws = 0, losses = 0;
    for (const r of rows) {
      bet += r.bet;
      payout += r.payout;
      if (isStoredDraw(r.result)) draws++;
      else if (isStoredWin(r.result, r.payout)) wins++;
      else losses++;
    }
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId);
    const net = payout - bet;
    const netStr = (net >= 0n ? '+' : '') + fmt(net);
    const e = new EmbedBuilder()
      .setColor(net >= 0n ? Colors.Success : Colors.Error)
      .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
      .setTitle('📊 Casino-Statistik')
      .addFields(
        { name: '🎲 Runden', value: String(rows.length), inline: false },
        { name: '🏆 Siege', value: String(wins), inline: true },
        { name: '⚠️ Unentschieden', value: String(draws), inline: true },
        { name: '❌ Niederlagen', value: String(losses), inline: true },
        { name: '🏆 Win-Rate', value: `${((wins / rows.length) * 100).toFixed(1)}%`, inline: false },
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
      rounds: rows.length,
      wins,
      draws,
      losses,
    });
  }),
};
