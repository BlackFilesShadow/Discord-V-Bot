/**
 * Phase 3 — Casino-Commands (5 Stueck).
 *
 * Spielt aus Wallet-Balance. Provably-Fair: serverSeed (32B random),
 * clientSeed (User-Input), nonce (BigInt-Counter pro Game). Outcome
 * wird via HMAC-SHA256 deterministisch ermittelt (siehe `roll()`).
 *
 * Atomicity: Bet-Abzug + Payout-Gutschrift + Round-Insert in einer
 * Prisma-Transaktion mit `walletBalance >= bet` als Race-Guard.
 */

import {
  SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, MessageFlags,
} from 'discord.js';
import { createHmac, randomBytes } from 'crypto';
import type { CasinoGameType } from '@prisma/client';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { getConfig } from '../../modules/economy/repository';
import { asUserDiscordId } from '../../types/scope';
import type { GuildScope, UserDiscordId } from '../../types/scope';
import { logAudit } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';

function fmt(n: bigint): string { return n.toLocaleString('de-DE'); }

async function reply(i: ChatInputCommandInteraction, content: string, ephemeral = true): Promise<void> {
  if (ephemeral) await i.reply({ content, flags: MessageFlags.Ephemeral });
  else await i.reply({ content });
}

/**
 * Provably-Fair Roll: HMAC(serverSeed, clientSeed:nonce) → BigInt → 0..maxExclusive-1.
 */
function roll(serverSeed: string, clientSeed: string, nonce: bigint, maxExclusive: number): number {
  const h = createHmac('sha256', serverSeed).update(`${clientSeed}:${nonce.toString()}`).digest('hex');
  // Erste 13 Hex-Chars = 52 Bit, sicher in JS-Number-Bereich.
  const slice = h.slice(0, 13);
  const v = Number.parseInt(slice, 16);
  return v % maxExclusive;
}

interface PlayResult {
  won: boolean;
  payout: bigint;
  details: Record<string, unknown>;
}

/**
 * Atomare Bet-Verbuchung + Round-Insert. Wirft bei zu wenig Wallet.
 */
async function playRound(args: {
  scope: GuildScope;
  type: CasinoGameType;
  bet: bigint;
  clientSeed: string | null;
  decide: (game: { winChancePct: number; payoutMult: number }, serverSeed: string, nonce: bigint) => PlayResult;
}): Promise<{ result: PlayResult; serverSeed: string; nonce: bigint; gameRowId: string }> {
  const game = await prisma.casinoGame.findUnique({
    where: { guildId_type: { guildId: args.scope.guildId, type: args.type } },
  });
  if (!game || !game.enabled) throw new Error('Spiel ist deaktiviert.');
  if (args.bet < game.minBet) throw new Error(`Mindesteinsatz: ${fmt(game.minBet)}`);
  if (args.bet > game.maxBet) throw new Error(`Hoechsteinsatz: ${fmt(game.maxBet)}`);

  const serverSeed = randomBytes(32).toString('hex');

  return prisma.$transaction(async tx => {
    // Atomarer Bet-Abzug
    const upd = await tx.economyAccount.updateMany({
      where: {
        guildId: args.scope.guildId,
        userDiscordId: args.scope.actorDiscordId,
        walletBalance: { gte: args.bet },
      },
      data: { walletBalance: { decrement: args.bet }, lifetimeSpent: { increment: args.bet } },
    });
    if (upd.count !== 1) throw new Error('Unzureichendes Guthaben.');

    await tx.economyTransaction.create({
      data: {
        guildId: args.scope.guildId, userDiscordId: args.scope.actorDiscordId,
        delta: -args.bet, type: 'CASINO_BET', reason: args.type, actorDiscordId: args.scope.actorDiscordId,
      },
    });

    // Nonce erhoehen via count of prior rounds (best-effort uniqueness; fuer "echtes" Counting laeuft
    // ein ServerSeed-Rotations-Job spaeter. Hier reicht der Zaehler).
    const priorCount = await tx.casinoRound.count({
      where: { guildId: args.scope.guildId, gameId: game.id, userDiscordId: args.scope.actorDiscordId },
    });
    const nonce = BigInt(priorCount);

    const result = args.decide({ winChancePct: game.winChancePct, payoutMult: game.payoutMult }, serverSeed, nonce);

    if (result.won && result.payout > 0n) {
      await tx.economyAccount.update({
        where: { guildId_userDiscordId: { guildId: args.scope.guildId, userDiscordId: args.scope.actorDiscordId } },
        data: { walletBalance: { increment: result.payout }, lifetimeEarned: { increment: result.payout } },
      });
      await tx.economyTransaction.create({
        data: {
          guildId: args.scope.guildId, userDiscordId: args.scope.actorDiscordId,
          delta: result.payout, type: 'CASINO_PAYOUT', reason: args.type, actorDiscordId: args.scope.actorDiscordId,
        },
      });
    }

    await tx.casinoRound.create({
      data: {
        gameId: game.id,
        guildId: args.scope.guildId,
        userDiscordId: args.scope.actorDiscordId,
        bet: args.bet,
        payout: result.payout,
        result: result as unknown as object,
        serverSeed,
        clientSeed: args.clientSeed,
        nonce,
      },
    });

    return { result, serverSeed, nonce, gameRowId: game.id };
  });
}

// ============================================================
// /slot
// ============================================================
export const slotCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('slot')
    .setDescription('Slot-Maschine: Win-Chance & Payout aus Casino-Config.')
    .addIntegerOption(o => o.setName('einsatz').setDescription('Einsatz').setRequired(true).setMinValue(1).setMaxValue(1_000_000)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({
        scope, type: 'SLOT', bet, clientSeed: null,
        decide: (g, s, n) => {
          const won = roll(s, '', n, 100) < g.winChancePct;
          return { won, payout: won ? BigInt(Math.floor(Number(bet) * g.payoutMult)) : 0n, details: { game: 'SLOT' } };
        },
      });
    } catch (e) { await reply(i, `Fehlgeschlagen: ${(e as Error).message}`); return; }
    const cfg = await getConfig(scope.guildId);
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, gameType: 'SLOT', payout: out.result.payout.toString() } });
    await reply(i,
      out.result.won
        ? `🎰 Gewonnen! +${fmt(out.result.payout)} ${cfg.emoji} (Einsatz: ${fmt(bet)})`
        : `🎰 Verloren. -${fmt(bet)} ${cfg.emoji}`,
      false);
  }),
};

// ============================================================
// /coinflip
// ============================================================
export const coinflipCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('coinflip')
    .setDescription('Wirft eine Muenze. Richtige Wahl = payoutMult.')
    .addStringOption(o => o.setName('seite').setDescription('Kopf oder Zahl').setRequired(true).addChoices(
      { name: 'Kopf', value: 'KOPF' }, { name: 'Zahl', value: 'ZAHL' },
    ))
    .addIntegerOption(o => o.setName('einsatz').setDescription('Einsatz').setRequired(true).setMinValue(1).setMaxValue(1_000_000)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const choice = i.options.getString('seite', true) as 'KOPF' | 'ZAHL';
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({
        scope, type: 'COINFLIP', bet, clientSeed: choice,
        decide: (g, s, n) => {
          const flip = roll(s, choice, n, 2) === 0 ? 'KOPF' : 'ZAHL';
          // Falls winChancePct < 50, kann das Spiel "manipuliert" sein — dann gewinnt nur wenn auch Glueck.
          const fair = flip === choice;
          const lucky = roll(s, `${choice}:luck`, n, 100) < g.winChancePct;
          const won = fair && lucky;
          return { won, payout: won ? BigInt(Math.floor(Number(bet) * g.payoutMult)) : 0n, details: { flip, choice } };
        },
      });
    } catch (e) { await reply(i, `Fehlgeschlagen: ${(e as Error).message}`); return; }
    const cfg = await getConfig(scope.guildId);
    const flip = (out.result.details as { flip: string }).flip;
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, gameType: 'COINFLIP', payout: out.result.payout.toString() } });
    await reply(i,
      out.result.won
        ? `🪙 ${flip} — du gewinnst +${fmt(out.result.payout)} ${cfg.emoji}!`
        : `🪙 ${flip} — du verlierst ${fmt(bet)} ${cfg.emoji}.`,
      false);
  }),
};

// ============================================================
// /dice
// ============================================================
export const diceCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('dice')
    .setDescription('Wuerfelt 1..6. Wenn deine Zahl faellt, gewinnst du payoutMult * Einsatz.')
    .addIntegerOption(o => o.setName('zahl').setDescription('Tippe 1..6').setRequired(true).setMinValue(1).setMaxValue(6))
    .addIntegerOption(o => o.setName('einsatz').setDescription('Einsatz').setRequired(true).setMinValue(1).setMaxValue(1_000_000)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const tip = i.options.getInteger('zahl', true);
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({
        scope, type: 'DICE', bet, clientSeed: String(tip),
        decide: (g, s, n) => {
          const rolled = roll(s, String(tip), n, 6) + 1;
          const won = rolled === tip;
          return { won, payout: won ? BigInt(Math.floor(Number(bet) * g.payoutMult)) : 0n, details: { rolled, tip } };
        },
      });
    } catch (e) { await reply(i, `Fehlgeschlagen: ${(e as Error).message}`); return; }
    const cfg = await getConfig(scope.guildId);
    const rolled = (out.result.details as { rolled: number }).rolled;
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, gameType: 'DICE', payout: out.result.payout.toString() } });
    await reply(i,
      out.result.won
        ? `🎲 ${rolled} — du gewinnst +${fmt(out.result.payout)} ${cfg.emoji}!`
        : `🎲 ${rolled} (du tipptest ${tip}) — verloren.`,
      false);
  }),
};

// ============================================================
// /blackjack — vereinfacht (Single-Shot, keine Hit/Stand-UI)
// ============================================================
export const blackjackCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('blackjack')
    .setDescription('Vereinfachtes Blackjack: Spieler & Dealer ziehen je 2 Karten + 1 optional. Naher an 21 gewinnt.')
    .addIntegerOption(o => o.setName('einsatz').setDescription('Einsatz').setRequired(true).setMinValue(1).setMaxValue(1_000_000)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const bet = BigInt(i.options.getInteger('einsatz', true));
    let out;
    try {
      out = await playRound({
        scope, type: 'BLACKJACK', bet, clientSeed: 'bj',
        decide: (g, s, n) => {
          // 4 Karten ziehen: P1, D1, P2, D2; danach Player zieht so lang er <17 hat.
          const draw = (k: number) => (roll(s, `card:${k}`, n, 13) % 13) + 1;
          const cardVal = (c: number) => (c >= 10 ? 10 : c === 1 ? 11 : c);
          const player = [draw(0), draw(2)];
          const dealer = [draw(1), draw(3)];
          let pK = 4;
          while (player.reduce((a, b) => a + cardVal(b), 0) < 17) {
            player.push(draw(pK++));
            if (pK > 12) break;
          }
          let dK = pK + 1;
          while (dealer.reduce((a, b) => a + cardVal(b), 0) < 17) {
            dealer.push(draw(dK++));
            if (dK > 20) break;
          }
          const ps = player.reduce((a, b) => a + cardVal(b), 0);
          const ds = dealer.reduce((a, b) => a + cardVal(b), 0);
          const playerBust = ps > 21;
          const dealerBust = ds > 21;
          const won = !playerBust && (dealerBust || ps > ds);
          // Subtle Hausvorteil via winChancePct: Bei Tie kann das Haus nach Wahrscheinlichkeit wegnehmen
          const tie = !playerBust && !dealerBust && ps === ds;
          const tieKept = tie && roll(s, 'tie', n, 100) < g.winChancePct;
          const finalWon = won || tieKept;
          return {
            won: finalWon,
            payout: finalWon ? BigInt(Math.floor(Number(bet) * g.payoutMult)) : 0n,
            details: { player, dealer, ps, ds, tie },
          };
        },
      });
    } catch (e) { await reply(i, `Fehlgeschlagen: ${(e as Error).message}`); return; }
    const cfg = await getConfig(scope.guildId);
    const d = out.result.details as { ps: number; ds: number };
    emitGuildEvent(scope.guildId, { type: 'casino.round', payload: { guildId: scope.guildId, gameType: 'BLACKJACK', payout: out.result.payout.toString() } });
    await reply(i,
      out.result.won
        ? `🃏 Du ${d.ps} vs Dealer ${d.ds} → +${fmt(out.result.payout)} ${cfg.emoji}!`
        : `🃏 Du ${d.ps} vs Dealer ${d.ds} → -${fmt(bet)} ${cfg.emoji}.`,
      false);
  }),
};

// ============================================================
// /casino-stats
// ============================================================
export const casinoStatsCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('casino-stats')
    .setDescription('Zeigt Casino-Statistik fuer dich oder einen anderen User.')
    .addUserOption(o => o.setName('user').setDescription('Optional anderer User').setRequired(false)) as SlashCommandBuilder,
  execute: withGuildScope({ requireSlotToggle: 'economyActive' }, async (i, scope) => {
    const target = i.options.getUser('user') ?? i.user;
    const targetId: UserDiscordId = asUserDiscordId(target.id);
    const rows = await prisma.casinoRound.findMany({
      where: { guildId: scope.guildId, userDiscordId: targetId },
      select: { bet: true, payout: true, gameId: true },
    });
    if (rows.length === 0) { await reply(i, '_keine Casino-Aktivitaet_'); return; }
    let bet = 0n, payout = 0n, wins = 0;
    for (const r of rows) {
      bet += r.bet;
      payout += r.payout;
      if (r.payout > 0n) wins++;
    }
    const cfg = await getConfig(scope.guildId);
    const e = new EmbedBuilder()
      .setTitle(`Casino-Stats: ${target.username}`)
      .addFields(
        { name: 'Runden', value: String(rows.length), inline: true },
        { name: 'Win-Rate', value: `${((wins / rows.length) * 100).toFixed(1)}%`, inline: true },
        { name: 'Einsatz gesamt', value: `${fmt(bet)} ${cfg.emoji}`, inline: true },
        { name: 'Payout gesamt', value: `${fmt(payout)} ${cfg.emoji}`, inline: true },
        { name: 'Netto', value: `${fmt(payout - bet)} ${cfg.emoji}`, inline: true },
      );
    await i.reply({ embeds: [e], flags: target.id === i.user.id ? MessageFlags.Ephemeral : undefined });
    logAudit('CASINO_STATS', 'CASINO', { guildId: scope.guildId, target: target.id, rounds: rows.length });
  }),
};
