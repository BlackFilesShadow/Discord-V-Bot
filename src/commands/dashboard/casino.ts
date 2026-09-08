/**
 * Casino V3 — eight server-scoped Discord games with one shared configuration,
 * audit and booking path.
 *
 * Production invariants:
 * - configured win chance is an explicit audited rule for every game;
 * - min/max/payout/cooldown come from the same scoped registry as dashboard UI;
 * - immutable rule snapshot + seed/nonce are stored with every round;
 * - all balance changes go through the central EconomyLedger inside the same DB
 *   transaction as CasinoRound and EconomyTransaction audit rows;
 * - decided rounds preserve historic lifetime semantics (bet=spent,
 *   payout=earned), while draw refunds stay lifetime-neutral;
 * - cooldown is serialized in PostgreSQL, not only in one Node process;
 * - Discord is acknowledged before any money mutation;
 * - V2 verification stays available for historic rounds, malformed V3 audit
 *   data fails closed instead of being mislabeled as legacy.
 */
import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  type InteractionReplyOptions,
} from 'discord.js';
import { createHash, createHmac, randomBytes, randomUUID } from 'crypto';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { withGuildScope } from '../middleware/withGuildScope';
import { getConfig } from '../../modules/economy/repository';
import { assertEconomyScopeReady } from '../../modules/economy/scopeMigration';
import { bookLedgerEntryInTx, type LedgerTx } from '../../modules/economy/ledger';
import { asUserDiscordId } from '../../types/scope';
import type { GuildScope, UserDiscordId } from '../../types/scope';
import { logAudit, logger } from '../../utils/logger';
import { emitGuildEvent } from '../../dashboard/socket/emitter';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { buildStatusEmbed } from '../../utils/statusEmbed';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import {
  CASINO_ALGORITHM_VERSION,
  LEGACY_CASINO_ALGORITHM_VERSION,
  MAX_CASINO_BET,
  payoutMultiplierMilli,
  type CasinoGameKey,
} from '../../modules/economy/casinoRules';
import {
  casinoDefinition,
  ensureCasinoRoundAnchor,
  getCasinoGameConfig,
  isCasinoGameKey,
  type CasinoGameConfig,
} from '../../modules/economy/casinoRegistry';

const DISCORD_MAX_CASINO_BET = Number(MAX_CASINO_BET);
const SIGNED_BIGINT_MASK = (1n << 63n) - 1n;
const LEGACY_TYPES = new Set<CasinoGameKey>(['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK']);

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

interface CasinoUserStatsRow {
  rounds: bigint;
  wins: bigint;
  draws: bigint;
  bet: bigint;
  payout: bigint;
}

interface CasinoVerifyDbRow {
  id: string;
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
  type: CasinoGameKey;
  winChancePct: number | null;
  payoutMultMilli: number;
  minBet: string;
  maxBet: string;
  cooldownSeconds: number | null;
  serverSeedHash: string;
}

type AuditSnapshotParse =
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'valid'; snapshot: CasinoAuditSnapshot };

class CasinoUserError extends Error {}

type RoundOutcome = 'WON' | 'LOST' | 'DRAW';

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
  const payload: InteractionReplyOptions = {
    embeds: [buildStatusEmbed({
      status: 'ERROR',
      title: 'Spiel nicht gestartet',
      description: 'Die Runde konnte nicht gestartet werden.',
      fields: [{ name: '📝 Grund', value: safeMessage }],
      footerText: 'V-Bot Casino',
    })],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };

  if (i.deferred || i.replied) {
    try { await i.deleteReply(); } catch { /* best effort: deferred public placeholder */ }
    await i.followUp(payload);
    return;
  }
  await i.reply(payload);
}

function buildRoundEmbed(args: {
  i: ChatInputCommandInteraction;
  type: CasinoGameKey;
  outcome: RoundOutcome;
  bet: bigint;
  payout: bigint;
  coin: string;
  details: { name: string; value: string; inline?: boolean }[];
  roundId: string;
  serverSeedHash: string;
  nonce: bigint;
  winChancePct: number;
}): EmbedBuilder {
  const def = casinoDefinition(args.type);
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
    .setTitle(`${def.emoji} ${def.label}`)
    .setDescription(`${meta.sym} **${meta.word}**`)
    .addFields(
      { name: '💰 Einsatz', value: `${fmt(args.bet)} ${args.coin}`, inline: true },
      { name: '🏆 Auszahlung', value: `${fmt(args.payout)} ${args.coin}`, inline: true },
      { name: '🎚️ Server-Chance', value: `${args.winChancePct}%`, inline: true },
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

/** Deterministic HMAC random integer with rejection sampling (no modulo bias). */
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

function safePayout(bet: bigint, multiplierMilli: number): bigint {
  if (!Number.isInteger(multiplierMilli) || multiplierMilli < 0) throw new Error('Ungueltiger Auszahlungs-Multiplikator.');
  return (bet * BigInt(multiplierMilli)) / 1000n;
}

function outcomeOf(result: PlayResult): RoundOutcome {
  if (result.draw) return 'DRAW';
  return result.won ? 'WON' : 'LOST';
}

function configuredOutcome(type: CasinoGameKey, clientSeed: string, game: RuntimeGameConfig, serverSeed: string, nonce: bigint): RoundOutcome {
  const won = roll(serverSeed, `outcome:${type}:${clientSeed}`, nonce, 10_000) < game.winChancePct * 100;
  if (won) return 'WON';
  const drawPct = casinoDefinition(type).drawConditionalPct;
  if (drawPct > 0) {
    const draw = roll(serverSeed, `draw:${type}:${clientSeed}`, nonce, 10_000) < drawPct * 100;
    if (draw) return 'DRAW';
  }
  return 'LOST';
}

function payoutForOutcome(outcome: RoundOutcome, bet: bigint, multiplierMilli: number): bigint {
  return outcome === 'DRAW' ? bet : outcome === 'WON' ? safePayout(bet, multiplierMilli) : 0n;
}

const SLOT_SYMBOLS = ['🍒', '🍋', '🔔', '⭐', '7️⃣', '💎'] as const;
const RED_NUMBERS = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36] as const;
const BLACK_NUMBERS = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35] as const;

const BLACKJACK_SCENARIOS: Record<RoundOutcome, ReadonlyArray<{ player: string[]; dealer: string[]; ps: number; ds: number }>> = {
  WON: [
    { player: ['A♠', 'K♥'], dealer: ['10♣', '8♦'], ps: 21, ds: 18 },
    { player: ['10♥', '10♠'], dealer: ['9♣', '8♦'], ps: 20, ds: 17 },
    { player: ['9♠', 'Q♥'], dealer: ['10♦', '7♣'], ps: 19, ds: 17 },
  ],
  DRAW: [
    { player: ['10♠', '8♥'], dealer: ['K♣', '8♦'], ps: 18, ds: 18 },
    { player: ['9♥', '9♣'], dealer: ['10♠', '8♦'], ps: 18, ds: 18 },
    { player: ['Q♠', '9♥'], dealer: ['K♣', '9♦'], ps: 19, ds: 19 },
  ],
  LOST: [
    { player: ['K♠', '8♥', '7♣'], dealer: ['10♣', '8♦'], ps: 25, ds: 18 },
    { player: ['10♠', '7♥'], dealer: ['K♣', '9♦'], ps: 17, ds: 19 },
    { player: ['9♠', '8♥'], dealer: ['Q♣', '9♦'], ps: 17, ds: 19 },
  ],
};

function resolveConfiguredGame(type: CasinoGameKey, bet: bigint, clientSeed: string, game: RuntimeGameConfig, serverSeed: string, nonce: bigint): PlayResult {
  const outcome = configuredOutcome(type, clientSeed, game, serverSeed, nonce);
  const won = outcome === 'WON';
  const draw = outcome === 'DRAW';
  const payout = payoutForOutcome(outcome, bet, game.payoutMultMilli);

  if (type === 'SLOT') {
    const a = roll(serverSeed, 'slot:a', nonce, SLOT_SYMBOLS.length);
    const b = won ? a : (a + 1 + roll(serverSeed, 'slot:b', nonce, SLOT_SYMBOLS.length - 1)) % SLOT_SYMBOLS.length;
    const c = won ? a : roll(serverSeed, 'slot:c', nonce, SLOT_SYMBOLS.length);
    return { won, draw: false, payout, details: { reels: [SLOT_SYMBOLS[a], SLOT_SYMBOLS[b], SLOT_SYMBOLS[c]] } };
  }
  if (type === 'COINFLIP') {
    if (clientSeed !== 'KOPF' && clientSeed !== 'ZAHL') throw new Error('Ungueltiger Coinflip-ClientSeed.');
    const flip = won ? clientSeed : clientSeed === 'KOPF' ? 'ZAHL' : 'KOPF';
    return { won, draw: false, payout, details: { flip, choice: clientSeed } };
  }
  if (type === 'DICE') {
    const tip = Number(clientSeed);
    if (!Number.isInteger(tip) || tip < 1 || tip > 6) throw new Error('Ungueltiger Dice-ClientSeed.');
    const missOffset = 1 + roll(serverSeed, 'dice:miss', nonce, 5);
    const rolled = won ? tip : ((tip - 1 + missOffset) % 6) + 1;
    return { won, draw: false, payout, details: { rolled, tip } };
  }
  if (type === 'BLACKJACK') {
    const scenarios = BLACKJACK_SCENARIOS[outcome];
    const details = scenarios[roll(serverSeed, `blackjack:visual:${outcome}`, nonce, scenarios.length)];
    return { won, draw, payout, details };
  }
  if (type === 'ROULETTE') {
    if (clientSeed !== 'ROT' && clientSeed !== 'SCHWARZ') throw new Error('Ungueltiger Roulette-ClientSeed.');
    const winningColor = won ? clientSeed : clientSeed === 'ROT' ? 'SCHWARZ' : 'ROT';
    const numbers = winningColor === 'ROT' ? RED_NUMBERS : BLACK_NUMBERS;
    const number = numbers[roll(serverSeed, `roulette:${winningColor}`, nonce, numbers.length)];
    return { won, draw: false, payout, details: { choice: clientSeed, color: winningColor, number } };
  }
  if (type === 'HIGHLOW') {
    if (clientSeed !== 'HOEHER' && clientSeed !== 'TIEFER') throw new Error('Ungueltiger High-Low-ClientSeed.');
    const first = 5 + roll(serverSeed, 'highlow:first', nonce, 5);
    const shouldBeHigher = won ? clientSeed === 'HOEHER' : clientSeed !== 'HOEHER';
    const delta = 1 + roll(serverSeed, 'highlow:delta', nonce, 3);
    const second = shouldBeHigher ? first + delta : first - delta;
    return { won, draw: false, payout, details: { choice: clientSeed, first, second } };
  }
  if (type === 'BACCARAT') {
    if (clientSeed !== 'SPIELER' && clientSeed !== 'BANKER') throw new Error('Ungueltiger Baccarat-ClientSeed.');
    if (draw) {
      const score = 5 + roll(serverSeed, 'baccarat:draw', nonce, 4);
      return { won: false, draw: true, payout, details: { choice: clientSeed, playerScore: score, bankerScore: score, winner: 'UNENTSCHIEDEN' } };
    }
    const winner = won ? clientSeed : clientSeed === 'SPIELER' ? 'BANKER' : 'SPIELER';
    const high = 7 + roll(serverSeed, 'baccarat:high', nonce, 3);
    const low = roll(serverSeed, 'baccarat:low', nonce, Math.max(1, high));
    return { won, draw: false, payout, details: {
      choice: clientSeed,
      playerScore: winner === 'SPIELER' ? high : low,
      bankerScore: winner === 'BANKER' ? high : low,
      winner,
    } };
  }
  return { won, draw: false, payout, details: { segment: won ? `x${(game.payoutMultMilli / 1000).toFixed(3)}` : 'x0' } };
}

/** Exact V2 replay for historic four-game snapshots. */
function blackjackScore(cards: number[]): number {
  let total = 0;
  let aces = 0;
  for (const card of cards) {
    if (card === 1) { total += 11; aces++; }
    else total += Math.min(card, 10);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function resolveLegacyV2Game(type: CasinoGameKey, bet: bigint, clientSeed: string, game: RuntimeGameConfig, serverSeed: string, nonce: bigint): PlayResult {
  if (!LEGACY_TYPES.has(type)) throw new Error('V2 kennt diesen Spieltyp nicht.');
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

function parseAuditSnapshot(value: unknown): AuditSnapshotParse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { kind: 'missing' };
  const result = value as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(result, 'audit')) return { kind: 'missing' };
  const audit = result.audit;
  if (!audit || typeof audit !== 'object' || Array.isArray(audit)) return { kind: 'invalid' };
  const row = audit as Record<string, unknown>;
  if (typeof row.algorithmVersion !== 'string' || typeof row.type !== 'string' || !isCasinoGameKey(row.type)) return { kind: 'invalid' };
  if (!Number.isInteger(row.payoutMultMilli) || (row.payoutMultMilli as number) < 1000 || (row.payoutMultMilli as number) > 100_000) return { kind: 'invalid' };
  if (typeof row.minBet !== 'string' || typeof row.maxBet !== 'string') return { kind: 'invalid' };
  if (typeof row.serverSeedHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.serverSeedHash)) return { kind: 'invalid' };
  let minBet: bigint;
  let maxBet: bigint;
  try { minBet = BigInt(row.minBet); maxBet = BigInt(row.maxBet); }
  catch { return { kind: 'invalid' }; }
  if (minBet < 1n || maxBet < minBet || maxBet > MAX_CASINO_BET) return { kind: 'invalid' };

  const isV3 = row.algorithmVersion === CASINO_ALGORITHM_VERSION;
  const isV2 = row.algorithmVersion === LEGACY_CASINO_ALGORITHM_VERSION;
  if (!isV3 && !isV2) return { kind: 'invalid' };
  if (isV3) {
    if (!Number.isInteger(row.winChancePct) || (row.winChancePct as number) < 1 || (row.winChancePct as number) > 99) return { kind: 'invalid' };
    if (!Number.isInteger(row.cooldownSeconds) || (row.cooldownSeconds as number) < 0 || (row.cooldownSeconds as number) > 3600) return { kind: 'invalid' };
  } else if (row.winChancePct !== null && (!Number.isInteger(row.winChancePct) || (row.winChancePct as number) < 1 || (row.winChancePct as number) > 99)) {
    return { kind: 'invalid' };
  }

  return { kind: 'valid', snapshot: {
    algorithmVersion: row.algorithmVersion,
    type: row.type,
    winChancePct: row.winChancePct as number | null,
    payoutMultMilli: row.payoutMultMilli as number,
    minBet: row.minBet,
    maxBet: row.maxBet,
    cooldownSeconds: typeof row.cooldownSeconds === 'number' ? row.cooldownSeconds : null,
    serverSeedHash: row.serverSeedHash,
  } };
}

function isStoredDraw(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).draw === true;
}

function isStoredWin(value: unknown, payout: bigint): boolean {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const won = (value as Record<string, unknown>).won;
    if (typeof won === 'boolean') return won;
  }
  return payout > 0n;
}

async function bookCasinoLedger(tx: LedgerTx, args: {
  guildId: string;
  nitradoConnId: string;
  userDiscordId: string;
  type: CasinoGameKey;
  roundId: string;
  bet: bigint;
  result: PlayResult;
}): Promise<void> {
  if (args.result.draw) {
    // Draw is a true refund: wallet and lifetime counters remain unchanged.
    await bookLedgerEntryInTx(tx, {
      idempotencyKey: `casino:round:${args.roundId}:draw`,
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      userDiscordId: args.userDiscordId,
      walletDelta: 0n,
      bankDelta: 0n,
      type: 'CASINO_PAYOUT',
      reason: `${args.type}:DRAW`,
      sourceRef: args.roundId,
    });
    return;
  }

  // Preserve the original Economy lifetime semantics for decided rounds:
  // the wager is spent, and an actual payout is earned.
  await bookLedgerEntryInTx(tx, {
    idempotencyKey: `casino:round:${args.roundId}:bet`,
    guildId: args.guildId,
    nitradoConnId: args.nitradoConnId,
    userDiscordId: args.userDiscordId,
    walletDelta: -args.bet,
    bankDelta: 0n,
    type: 'CASINO_BET',
    reason: args.type,
    sourceRef: args.roundId,
  });
  if (args.result.payout > 0n) {
    await bookLedgerEntryInTx(tx, {
      idempotencyKey: `casino:round:${args.roundId}:payout`,
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      userDiscordId: args.userDiscordId,
      walletDelta: args.result.payout,
      bankDelta: 0n,
      type: 'CASINO_PAYOUT',
      reason: args.type,
      sourceRef: args.roundId,
    });
  }
}

async function playRound(args: {
  scope: GuildScope;
  type: CasinoGameKey;
  bet: bigint;
  clientSeed: string;
}): Promise<{ result: PlayResult; serverSeed: string; nonce: bigint; roundId: string; config: CasinoGameConfig }> {
  const nitradoConnId = args.scope.nitradoConnId;
  if (!nitradoConnId) throw new CasinoUserError('Kein Gameserver-Scope fuer Casino aufgeloest.');
  await assertEconomyScopeReady(args.scope.guildId, nitradoConnId);

  const config = await getCasinoGameConfig(args.scope.guildId, nitradoConnId, args.type);
  if (!config.enabled) throw new CasinoUserError('Spiel ist deaktiviert.');
  if (args.bet < config.minBet) throw new CasinoUserError(`Mindesteinsatz: ${fmt(config.minBet)}`);
  if (args.bet > config.maxBet) throw new CasinoUserError(`Hoechsteinsatz: ${fmt(config.maxBet)}`);

  const serverSeed = randomBytes(32).toString('hex');
  const nonce = randomNonce();
  const roundId = randomUUID();
  const runtimeGame = { winChancePct: config.winChancePct, payoutMultMilli: payoutMultiplierMilli(config.payoutMult) };
  const result = resolveConfiguredGame(args.type, args.bet, args.clientSeed, runtimeGame, serverSeed, nonce);
  const anchorGameId = await ensureCasinoRoundAnchor(args.scope.guildId, nitradoConnId, args.type);
  const storedResult = {
    ...result,
    audit: {
      algorithmVersion: CASINO_ALGORITHM_VERSION,
      type: args.type,
      winChancePct: config.winChancePct,
      payoutMultMilli: runtimeGame.payoutMultMilli,
      minBet: config.minBet.toString(),
      maxBet: config.maxBet.toString(),
      cooldownSeconds: config.cooldownSeconds,
      serverSeedHash: seedHashFull(serverSeed),
    } satisfies CasinoAuditSnapshot,
  };

  await prisma.$transaction(async tx => {
    const db = tx as unknown as RawDb;
    const lockKey = `casino:${args.scope.guildId}:${nitradoConnId}:${args.scope.actorDiscordId}:${args.type}`;
    await db.$queryRawUnsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', lockKey);

    if (config.cooldownSeconds > 0) {
      const previous = await queryOne<{ createdAt: Date }>(
        db,
        `SELECT r."createdAt" FROM "CasinoRound" r
          JOIN "CasinoGame" g ON g."id" = r."gameId"
         WHERE r."guildId"=$1 AND r."nitradoConnId"=$2 AND r."userDiscordId"=$3
           AND COALESCE(r."result"->'audit'->>'type', g."type"::text)=$4
         ORDER BY r."createdAt" DESC LIMIT 1`,
        String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId), args.type,
      );
      if (previous) {
        const waitMs = config.cooldownSeconds * 1000 - (Date.now() - previous.createdAt.getTime());
        if (waitMs > 0) throw new CasinoUserError(`Bitte warte noch ${Math.ceil(waitMs / 1000)} Sekunde(n).`);
      }
    }

    const account = await queryOne<{ walletBalance: bigint }>(
      db,
      `SELECT "walletBalance" FROM "EconomyAccount"
        WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3 FOR UPDATE`,
      String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
    );
    if (!account || account.walletBalance < args.bet) throw new CasinoUserError('Unzureichendes Guthaben.');

    await bookCasinoLedger(tx as unknown as LedgerTx, {
      guildId: String(args.scope.guildId),
      nitradoConnId: String(nitradoConnId),
      userDiscordId: String(args.scope.actorDiscordId),
      type: args.type,
      roundId,
      bet: args.bet,
      result,
    });

    // Detail transactions preserve the familiar gross bet/payout audit trail.
    await db.$executeRawUnsafe(
      'INSERT INTO "EconomyTransaction" ("id","guildId","nitradoConnId","userDiscordId","delta","type","reason","actorDiscordId","counterpartDiscordId","createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,NULL,CURRENT_TIMESTAMP)',
      randomUUID(), String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
      -args.bet, 'CASINO_BET', args.type, String(args.scope.actorDiscordId),
    );
    if (result.payout > 0n) {
      await db.$executeRawUnsafe(
        'INSERT INTO "EconomyTransaction" ("id","guildId","nitradoConnId","userDiscordId","delta","type","reason","actorDiscordId","counterpartDiscordId","createdAt") VALUES ($1,$2,$3,$4,$5,$6::"EconomyTxType",$7,$8,NULL,CURRENT_TIMESTAMP)',
        randomUUID(), String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
        result.payout, 'CASINO_PAYOUT', result.draw ? `${args.type}:DRAW_REFUND` : args.type, String(args.scope.actorDiscordId),
      );
    }

    await db.$executeRawUnsafe(
      'INSERT INTO "CasinoRound" ("id","gameId","guildId","nitradoConnId","userDiscordId","bet","payout","result","serverSeed","clientSeed","nonce","createdAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,CURRENT_TIMESTAMP)',
      roundId, anchorGameId, String(args.scope.guildId), String(nitradoConnId), String(args.scope.actorDiscordId),
      args.bet, result.payout,
      JSON.stringify(storedResult, (_key, value) => typeof value === 'bigint' ? value.toString() : value),
      serverSeed, args.clientSeed, nonce,
    );
  });

  return { result, serverSeed, nonce, roundId, config };
}

function embedDetails(type: CasinoGameKey, result: PlayResult): { name: string; value: string; inline?: boolean }[] {
  const d = result.details;
  switch (type) {
    case 'SLOT': return [{ name: '🎰 Walzen', value: (d.reels as string[]).join('  '), inline: false }];
    case 'COINFLIP': return [
      { name: '🎯 Deine Wahl', value: d.choice === 'KOPF' ? 'Kopf' : 'Zahl', inline: true },
      { name: '🪙 Ergebnis', value: d.flip === 'KOPF' ? 'Kopf' : 'Zahl', inline: true },
    ];
    case 'DICE': return [
      { name: '🎯 Dein Tipp', value: String(d.tip), inline: true },
      { name: '🎲 Gewuerfelt', value: String(d.rolled), inline: true },
    ];
    case 'BLACKJACK': return [
      { name: '🧍 Deine Karten', value: (d.player as string[]).join('  '), inline: false },
      { name: '📊 Dein Wert', value: String(d.ps), inline: true },
      { name: '🎩 Dealer', value: (d.dealer as string[]).join('  '), inline: false },
      { name: '📊 Dealer-Wert', value: String(d.ds), inline: true },
    ];
    case 'ROULETTE': return [
      { name: '🎯 Deine Farbe', value: d.choice === 'ROT' ? '🔴 Rot' : '⚫ Schwarz', inline: true },
      { name: '🎡 Kugel', value: `${d.number} • ${d.color === 'ROT' ? '🔴 Rot' : '⚫ Schwarz'}`, inline: true },
    ];
    case 'HIGHLOW': return [
      { name: '🃏 Ausgangskarte', value: String(d.first), inline: true },
      { name: '🎯 Dein Tipp', value: d.choice === 'HOEHER' ? 'Höher' : 'Tiefer', inline: true },
      { name: '🃏 Naechste Karte', value: String(d.second), inline: true },
    ];
    case 'BACCARAT': return [
      { name: '🎯 Deine Wahl', value: d.choice === 'SPIELER' ? 'Spieler' : 'Banker', inline: true },
      { name: '🧍 Spieler', value: String(d.playerScore), inline: true },
      { name: '🏦 Banker', value: String(d.bankerScore), inline: true },
      { name: '🏁 Ergebnis', value: String(d.winner), inline: false },
    ];
    case 'WHEEL': return [{ name: '🎯 Feld', value: String(d.segment), inline: false }];
  }
}

async function executeGame(i: ChatInputCommandInteraction, scope: GuildScope, type: CasinoGameKey, clientSeed: string): Promise<void> {
  const bet = BigInt(i.options.getInteger('einsatz', true));
  try {
    await i.deferReply();
    // Currency config is read before the financial transaction so a later
    // presentation dependency can never fail only after money was committed.
    const economyConfig = await getConfig(scope.guildId, scope.nitradoConnId!);
    const out = await playRound({ scope, type, bet, clientSeed });

    try {
      emitGuildEvent(scope.guildId, {
        type: 'casino.round',
        payload: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          gameType: type,
          payout: out.result.payout.toString(),
          outcome: outcomeOf(out.result),
        },
      });
    } catch (error) {
      logger.warn('Casino websocket event failed after committed round', {
        guildId: scope.guildId,
        roundId: out.roundId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await i.editReply({
      embeds: [buildRoundEmbed({
        i,
        type,
        outcome: outcomeOf(out.result),
        bet,
        payout: out.result.payout,
        coin: economyConfig.emoji,
        details: embedDetails(type, out.result),
        roundId: out.roundId,
        serverSeedHash: seedHash(out.serverSeed),
        nonce: out.nonce,
        winChancePct: out.config.winChancePct,
      })],
      allowedMentions: { parse: [] },
    });
  } catch (e) {
    await statusFail(i, e);
  }
}

export const slotCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder().setName('slot').setDescription('Slot-Maschine dieses Gameservers.'))),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => executeGame(i, scope, 'SLOT', 'slot')),
};
export const coinflipCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder().setName('coinflip').setDescription('Kopf oder Zahl mit der konfigurierten Server-Chance.')
    .addStringOption(o => o.setName('seite').setDescription('Kopf oder Zahl').setRequired(true).addChoices({ name: 'Kopf', value: 'KOPF' }, { name: 'Zahl', value: 'ZAHL' })) as SlashCommandBuilder)),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => executeGame(i, scope, 'COINFLIP', i.options.getString('seite', true))),
};
export const diceCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder().setName('dice').setDescription('Wuerfelspiel: Tippe eine Zahl von 1 bis 6.')
    .addIntegerOption(o => o.setName('zahl').setDescription('Dein Tipp').setRequired(true).setMinValue(1).setMaxValue(6)) as SlashCommandBuilder)),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => executeGame(i, scope, 'DICE', String(i.options.getInteger('zahl', true)))),
};
export const blackjackCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder().setName('blackjack').setDescription('Automatische Blackjack-Runde.'))),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => executeGame(i, scope, 'BLACKJACK', 'blackjack')),
};
export const rouletteCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder().setName('roulette').setDescription('Roulette: Setze auf Rot oder Schwarz.')
    .addStringOption(o => o.setName('farbe').setDescription('Deine Farbe').setRequired(true).addChoices({ name: 'Rot', value: 'ROT' }, { name: 'Schwarz', value: 'SCHWARZ' })) as SlashCommandBuilder)),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => executeGame(i, scope, 'ROULETTE', i.options.getString('farbe', true))),
};
export const highLowCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder().setName('highlow').setDescription('High-Low: Wird die naechste Karte hoeher oder tiefer?')
    .addStringOption(o => o.setName('wahl').setDescription('Hoeher oder tiefer').setRequired(true).addChoices({ name: 'Höher', value: 'HOEHER' }, { name: 'Tiefer', value: 'TIEFER' })) as SlashCommandBuilder)),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => executeGame(i, scope, 'HIGHLOW', i.options.getString('wahl', true))),
};
export const baccaratCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder().setName('baccarat').setDescription('Baccarat: Setze auf Spieler oder Banker.')
    .addStringOption(o => o.setName('seite').setDescription('Spieler oder Banker').setRequired(true).addChoices({ name: 'Spieler', value: 'SPIELER' }, { name: 'Banker', value: 'BANKER' })) as SlashCommandBuilder)),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => executeGame(i, scope, 'BACCARAT', i.options.getString('seite', true))),
};
export const wheelCommand: Command = {
  data: slotOption(betOption(new SlashCommandBuilder().setName('wheel').setDescription('Dreht das Casino-Gluecksrad.'))),
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => executeGame(i, scope, 'WHEEL', 'wheel')),
};

export const casinoStatsCommand: Command = {
  data: slotOption(new SlashCommandBuilder().setName('casino-stats').setDescription('Zeigt Casino-Statistik fuer dich oder einen anderen User.')
    .addUserOption(o => o.setName('user').setDescription('Optional anderer User').setRequired(false)) as SlashCommandBuilder),
  cooldown: 3,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    const target = i.options.getUser('user') ?? i.user;
    const targetId: UserDiscordId = asUserDiscordId(target.id);
    await i.deferReply({ flags: target.id === i.user.id ? MessageFlags.Ephemeral : undefined });
    if (!scope.nitradoConnId) throw new Error('Kein Gameserver-Scope fuer Casino aufgeloest.');
    await assertEconomyScopeReady(scope.guildId, scope.nitradoConnId);
    const row = await queryOne<CasinoUserStatsRow>(
      prisma as unknown as RawDb,
      `SELECT COUNT(*)::bigint AS "rounds",
              COUNT(*) FILTER (WHERE "result"->>'draw' = 'true')::bigint AS "draws",
              COUNT(*) FILTER (WHERE COALESCE("result"->>'draw','false') <> 'true'
                AND CASE WHEN "result" ? 'won' THEN "result"->>'won'='true' ELSE "payout">0 END)::bigint AS "wins",
              COALESCE(SUM("bet"),0)::bigint AS "bet", COALESCE(SUM("payout"),0)::bigint AS "payout"
         FROM "CasinoRound" WHERE "guildId"=$1 AND "nitradoConnId"=$2 AND "userDiscordId"=$3`,
      String(scope.guildId), String(scope.nitradoConnId), String(targetId),
    );
    const rounds = row?.rounds ?? 0n;
    if (rounds === 0n) {
      await i.editReply({ embeds: [buildStatusEmbed({
        status: 'INFO', title: 'Casino-Statistik',
        description: `Fuer ${target.username} liegt noch keine Casino-Aktivitaet vor.`,
        footerText: 'V-Bot Casino',
      })], allowedMentions: { parse: [] } });
      return;
    }
    const wins = row?.wins ?? 0n;
    const draws = row?.draws ?? 0n;
    const losses = rounds - wins - draws;
    const decided = wins + losses;
    const bet = row?.bet ?? 0n;
    const payout = row?.payout ?? 0n;
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId);
    const net = payout - bet;
    const winRate = decided > 0n ? Number((wins * 10_000n) / decided) / 100 : 0;
    const e = vEmbed(net >= 0n ? Colors.Success : Colors.Error)
      .setAuthor({ name: target.username, iconURL: target.displayAvatarURL() })
      .setTitle('📊 Casino-Statistik')
      .addFields(
        { name: '🎲 Runden', value: rounds.toString(), inline: false },
        { name: '🏆 Siege', value: wins.toString(), inline: true },
        { name: '⚠️ Unentschieden', value: draws.toString(), inline: true },
        { name: '❌ Niederlagen', value: losses.toString(), inline: true },
        { name: '🏆 Win-Rate (entschieden)', value: `${winRate.toFixed(2)}%`, inline: false },
        { name: '💰 Einsatz gesamt', value: `${fmt(bet)} ${cfg.emoji}`, inline: false },
        { name: '🏆 Auszahlung gesamt', value: `${fmt(payout)} ${cfg.emoji}`, inline: false },
        { name: '📊 Netto', value: `${net >= 0n ? '+' : ''}${fmt(net)} ${cfg.emoji}`, inline: false },
      ).setFooter({ text: 'V-Bot Casino' }).setTimestamp();
    await i.editReply({ embeds: [e], allowedMentions: { parse: [] } });
    logAudit('CASINO_STATS', 'CASINO', {
      guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, target: target.id,
      rounds: rounds.toString(), wins: wins.toString(), draws: draws.toString(), losses: losses.toString(),
    });
  }),
};

export const casinoVerifyCommand: Command = {
  data: slotOption(new SlashCommandBuilder().setName('casino-verify')
    .setDescription('Prueft Seed, Nonce, Regel-Snapshot und Auszahlung einer eigenen Casino-Runde.')
    .addStringOption(o => o.setName('runde').setDescription('Runden-ID aus dem Casino-Embed').setRequired(true).setMinLength(1).setMaxLength(128)) as SlashCommandBuilder),
  cooldown: 3,
  execute: withGuildScope({ requireSlotToggle: 'economyActive', acceptSlotOption: true }, async (i, scope) => {
    await i.deferReply({ flags: MessageFlags.Ephemeral });
    if (!scope.nitradoConnId) throw new Error('Kein Gameserver-Scope fuer Casino aufgeloest.');
    await assertEconomyScopeReady(scope.guildId, scope.nitradoConnId);
    const roundId = i.options.getString('runde', true).trim();
    const round = await queryOne<CasinoVerifyDbRow>(
      prisma as unknown as RawDb,
      `SELECT "id","bet","payout","result","serverSeed","clientSeed","nonce","createdAt"
         FROM "CasinoRound" WHERE "id"=$1 AND "guildId"=$2 AND "nitradoConnId"=$3 AND "userDiscordId"=$4 LIMIT 1`,
      roundId, String(scope.guildId), String(scope.nitradoConnId), String(scope.actorDiscordId),
    );
    if (!round) {
      await i.editReply({ embeds: [buildStatusEmbed({
        status: 'ERROR', title: 'Runde nicht gefunden',
        description: 'Die Runde existiert in diesem Gameserver-Slot nicht oder gehoert nicht dir.', footerText: 'V-Bot Casino Audit',
      })], allowedMentions: { parse: [] } });
      return;
    }

    const parsed = parseAuditSnapshot(round.result);
    if (parsed.kind === 'missing') {
      await i.editReply({ embeds: [buildStatusEmbed({
        status: 'INFO', title: '⚠️ Legacy-Runde',
        description: 'Diese Runde besitzt noch keinen vollstaendigen Regel-Snapshot und kann deshalb nicht vollstaendig nachgerechnet werden.',
        fields: [{ name: 'Runde', value: `\`${round.id}\`` }, { name: 'Seed-Hash', value: `\`${seedHashFull(round.serverSeed)}\`` }],
        footerText: 'V-Bot Casino Audit',
      })], allowedMentions: { parse: [] } });
      return;
    }
    if (parsed.kind === 'invalid') {
      await i.editReply({ embeds: [buildStatusEmbed({
        status: 'ERROR', title: '❌ Audit-Snapshot ungueltig',
        description: 'Die Runde enthaelt Audit-Daten, aber der Snapshot ist strukturell ungueltig oder wurde veraendert.',
        footerText: 'V-Bot Casino Audit',
      })], allowedMentions: { parse: [] } });
      return;
    }
    const snapshot = parsed.snapshot;
    const clientSeed = round.clientSeed ?? (snapshot.type === 'SLOT' ? 'slot' : snapshot.type === 'BLACKJACK' ? 'blackjack' : snapshot.type === 'WHEEL' ? 'wheel' : '');
    let replay: PlayResult;
    try {
      const runtime = { winChancePct: snapshot.winChancePct ?? 0, payoutMultMilli: snapshot.payoutMultMilli };
      replay = snapshot.algorithmVersion === CASINO_ALGORITHM_VERSION
        ? resolveConfiguredGame(snapshot.type, round.bet, clientSeed, runtime, round.serverSeed, round.nonce)
        : resolveLegacyV2Game(snapshot.type, round.bet, clientSeed, runtime, round.serverSeed, round.nonce);
    } catch (error) {
      logger.error('Casino verify replay failed', { guildId: scope.guildId, roundId: round.id, error: error instanceof Error ? error.message : String(error) });
      await i.editReply({ embeds: [buildStatusEmbed({
        status: 'ERROR', title: 'Audit fehlgeschlagen',
        description: 'Die gespeicherte Runde konnte mit ihrem Audit-Snapshot nicht reproduziert werden.', footerText: 'V-Bot Casino Audit',
      })], allowedMentions: { parse: [] } });
      return;
    }

    const min = BigInt(snapshot.minBet);
    const max = BigInt(snapshot.maxBet);
    const storedDraw = isStoredDraw(round.result);
    const storedWin = isStoredWin(round.result, round.payout);
    const hashMatches = seedHashFull(round.serverSeed) === snapshot.serverSeedHash;
    const payoutMatches = replay.payout === round.payout;
    const outcomeMatches = replay.draw === storedDraw && replay.won === storedWin;
    const betBoundsMatch = round.bet >= min && round.bet <= max;
    const verified = hashMatches && payoutMatches && outcomeMatches && betBoundsMatch;
    const cfg = await getConfig(scope.guildId, scope.nitradoConnId);
    const def = casinoDefinition(snapshot.type);
    const embed = vEmbed(verified ? Colors.Success : Colors.Error)
      .setTitle(verified ? '✅ Casino-Runde verifiziert' : '❌ Casino-Runde NICHT verifiziert')
      .setDescription(verified
        ? 'Seed, Nonce, Regel-Snapshot, Einsatzgrenzen, Outcome und Auszahlung sind reproduzierbar.'
        : 'Mindestens ein gespeicherter Audit-Wert stimmt nicht mit der reproduzierten Runde ueberein.')
      .addFields(
        { name: '🎲 Spiel', value: `${def.emoji} ${def.label}`, inline: true },
        { name: '💰 Einsatz', value: `${fmt(round.bet)} ${cfg.emoji}`, inline: true },
        { name: '🏆 Auszahlung', value: `${fmt(round.payout)} ${cfg.emoji}`, inline: true },
        { name: '🧩 Algorithmus', value: snapshot.algorithmVersion, inline: false },
        { name: '🎚️ Gewinnchance', value: snapshot.winChancePct === null ? 'Legacy-Regel' : `${snapshot.winChancePct}%`, inline: true },
        { name: '🔑 Server-Seed', value: `\`${round.serverSeed}\``, inline: false },
        { name: '🧑 Client-Seed', value: `\`${clientSeed}\``, inline: false },
        { name: '#️⃣ Nonce', value: round.nonce.toString(), inline: false },
        { name: '🔐 SHA-256', value: `\`${seedHashFull(round.serverSeed)}\``, inline: false },
        { name: '⚙️ Snapshot', value: `Payout x${(snapshot.payoutMultMilli / 1000).toFixed(3)} • Min ${snapshot.minBet} • Max ${snapshot.maxBet}${snapshot.cooldownSeconds !== null ? ` • Cooldown ${snapshot.cooldownSeconds}s` : ''}`, inline: false },
      ).setFooter({ text: `V-Bot Casino Audit • Runde ${round.id}` }).setTimestamp(round.createdAt);
    await i.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    logAudit('CASINO_VERIFY', 'CASINO', {
      guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, roundId: round.id,
      type: snapshot.type, algorithmVersion: snapshot.algorithmVersion,
      verified, hashMatches, payoutMatches, outcomeMatches, betBoundsMatch,
    });
  }),
};
