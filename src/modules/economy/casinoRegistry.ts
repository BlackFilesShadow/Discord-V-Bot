import type { CasinoGameType, Prisma } from '@prisma/client';
import prisma from '../../database/prisma';

/**
 * Casino V3 registry.
 *
 * The public game identity is intentionally independent from Prisma's legacy
 * four-value CasinoGameType enum. Existing CasinoGame rows remain stable FK
 * anchors for CasinoRound, while the immutable round snapshot stores the real
 * V3 game key. This lets new games ship without rewriting historic rows or
 * forcing a PostgreSQL enum rewrite solely for presentation/config identity.
 */
export const CASINO_GAME_KEYS = [
  'SLOT',
  'COINFLIP',
  'DICE',
  'BLACKJACK',
  'ROULETTE',
  'HIGHLOW',
  'BACCARAT',
  'WHEEL',
] as const;

export type CasinoGameKey = (typeof CASINO_GAME_KEYS)[number];
export type CasinoChoiceModel = 'NONE' | 'COIN_SIDE' | 'DICE_NUMBER' | 'ROULETTE_COLOR' | 'HIGHLOW_DIRECTION' | 'BACCARAT_SIDE';

export interface CasinoGameConfig {
  enabled: boolean;
  winChancePct: number;
  payoutMult: number;
  minBet: bigint;
  maxBet: bigint;
  cooldownSeconds: number;
}

export interface CasinoGameDefinition {
  key: CasinoGameKey;
  command: string;
  label: string;
  emoji: string;
  description: string;
  choiceModel: CasinoChoiceModel;
  /** Conditional draw chance after the configured win roll failed. */
  drawConditionalPct: number;
  anchorType: CasinoGameType;
  defaults: CasinoGameConfig;
}

const DEFINITIONS: Record<CasinoGameKey, CasinoGameDefinition> = {
  SLOT: {
    key: 'SLOT', command: 'slot', label: 'Slot', emoji: '🎰',
    description: 'Drei Walzen mit konfigurierbarer Gewinnchance.',
    choiceModel: 'NONE', drawConditionalPct: 0, anchorType: 'SLOT',
    defaults: { enabled: false, winChancePct: 45, payoutMult: 2, minBet: 1n, maxBet: 10_000n, cooldownSeconds: 2 },
  },
  COINFLIP: {
    key: 'COINFLIP', command: 'coinflip', label: 'Coinflip', emoji: '🪙',
    description: 'Kopf oder Zahl; die konfigurierte Gewinnchance ist die Serverregel.',
    choiceModel: 'COIN_SIDE', drawConditionalPct: 0, anchorType: 'COINFLIP',
    defaults: { enabled: false, winChancePct: 48, payoutMult: 2, minBet: 1n, maxBet: 10_000n, cooldownSeconds: 2 },
  },
  DICE: {
    key: 'DICE', command: 'dice', label: 'Dice', emoji: '🎲',
    description: 'Zahl 1 bis 6 tippen; Trefferquote wird serverseitig konfiguriert.',
    choiceModel: 'DICE_NUMBER', drawConditionalPct: 0, anchorType: 'DICE',
    defaults: { enabled: false, winChancePct: 16, payoutMult: 5.5, minBet: 1n, maxBet: 10_000n, cooldownSeconds: 2 },
  },
  BLACKJACK: {
    key: 'BLACKJACK', command: 'blackjack', label: 'Blackjack', emoji: '🃏',
    description: 'Automatische Kartenrunde mit transparent konfigurierter Gewinnchance.',
    choiceModel: 'NONE', drawConditionalPct: 10, anchorType: 'BLACKJACK',
    defaults: { enabled: false, winChancePct: 42, payoutMult: 2, minBet: 1n, maxBet: 10_000n, cooldownSeconds: 2 },
  },
  ROULETTE: {
    key: 'ROULETTE', command: 'roulette', label: 'Roulette', emoji: '🎡',
    description: 'Rot oder Schwarz; die Kugel wird passend zum auditierten Outcome ermittelt.',
    choiceModel: 'ROULETTE_COLOR', drawConditionalPct: 0, anchorType: 'DICE',
    defaults: { enabled: false, winChancePct: 47, payoutMult: 2, minBet: 1n, maxBet: 10_000n, cooldownSeconds: 2 },
  },
  HIGHLOW: {
    key: 'HIGHLOW', command: 'highlow', label: 'High-Low', emoji: '🔼',
    description: 'Tippe, ob die zweite Karte höher oder niedriger ist.',
    choiceModel: 'HIGHLOW_DIRECTION', drawConditionalPct: 0, anchorType: 'COINFLIP',
    defaults: { enabled: false, winChancePct: 48, payoutMult: 1.9, minBet: 1n, maxBet: 10_000n, cooldownSeconds: 2 },
  },
  BACCARAT: {
    key: 'BACCARAT', command: 'baccarat', label: 'Baccarat', emoji: '🎴',
    description: 'Spieler oder Banker wählen; Gleichstand erstattet den Einsatz.',
    choiceModel: 'BACCARAT_SIDE', drawConditionalPct: 8, anchorType: 'BLACKJACK',
    defaults: { enabled: false, winChancePct: 45, payoutMult: 2, minBet: 1n, maxBet: 10_000n, cooldownSeconds: 2 },
  },
  WHEEL: {
    key: 'WHEEL', command: 'wheel', label: 'Glücksrad', emoji: '🎯',
    description: 'Schnelle Rad-Runde mit konfigurierbarer Trefferquote und Auszahlung.',
    choiceModel: 'NONE', drawConditionalPct: 0, anchorType: 'SLOT',
    defaults: { enabled: false, winChancePct: 35, payoutMult: 2.5, minBet: 1n, maxBet: 10_000n, cooldownSeconds: 2 },
  },
};

const KEY_SET = new Set<string>(CASINO_GAME_KEYS);
const MAX_CONFIG_BET = 1_000_000_000_000_000n;

export function isCasinoGameKey(value: string): value is CasinoGameKey {
  return KEY_SET.has(value);
}

export function casinoDefinition(type: CasinoGameKey): CasinoGameDefinition {
  const d = DEFINITIONS[type];
  return { ...d, defaults: { ...d.defaults } };
}

export function casinoDefinitions(): CasinoGameDefinition[] {
  return CASINO_GAME_KEYS.map(casinoDefinition);
}

export function casinoConfigKey(guildId: string, nitradoConnId: string, type: CasinoGameKey): string {
  return `casino.v3:${guildId}:${nitradoConnId}:${type}`;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseStoredConfig(type: CasinoGameKey, value: unknown): CasinoGameConfig | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const win = finiteNumber(row.winChancePct);
  const payout = finiteNumber(row.payoutMult);
  const cooldown = finiteNumber(row.cooldownSeconds);
  if (typeof row.enabled !== 'boolean' || win === null || payout === null || cooldown === null) return null;
  if (typeof row.minBet !== 'string' || typeof row.maxBet !== 'string') return null;
  let minBet: bigint;
  let maxBet: bigint;
  try {
    minBet = BigInt(row.minBet);
    maxBet = BigInt(row.maxBet);
  } catch {
    return null;
  }
  const config: CasinoGameConfig = {
    enabled: row.enabled,
    winChancePct: win,
    payoutMult: payout,
    minBet,
    maxBet,
    cooldownSeconds: cooldown,
  };
  try {
    validateCasinoConfig(type, config);
  } catch {
    return null;
  }
  return config;
}

export function theoreticalCasinoRtpPct(type: CasinoGameKey, winChancePct: number, payoutMult: number): number {
  const def = DEFINITIONS[type];
  const win = winChancePct / 100;
  const nonWin = 1 - win;
  const conditionalDraw = def.drawConditionalPct / 100;
  return (win * payoutMult + nonWin * conditionalDraw) * 100;
}

export function validateCasinoConfig(type: CasinoGameKey, config: CasinoGameConfig): CasinoGameConfig {
  if (!Number.isInteger(config.winChancePct) || config.winChancePct < 1 || config.winChancePct > 99) {
    throw new Error('Gewinnchance muss eine ganze Zahl von 1 bis 99 Prozent sein.');
  }
  if (!Number.isFinite(config.payoutMult) || config.payoutMult < 1 || config.payoutMult > 100) {
    throw new Error('Auszahlung muss zwischen x1 und x100 liegen.');
  }
  if (config.minBet < 1n || config.minBet > MAX_CONFIG_BET) throw new Error('Mindesteinsatz ist ungueltig.');
  if (config.maxBet < config.minBet || config.maxBet > MAX_CONFIG_BET) throw new Error('Maximaleinsatz ist ungueltig.');
  if (!Number.isInteger(config.cooldownSeconds) || config.cooldownSeconds < 0 || config.cooldownSeconds > 3_600) {
    throw new Error('Cooldown muss zwischen 0 und 3600 Sekunden liegen.');
  }
  const rtp = theoreticalCasinoRtpPct(type, config.winChancePct, config.payoutMult);
  if (!Number.isFinite(rtp) || rtp > 100 + 1e-9) {
    throw new Error(`Theoretischer RTP ${rtp.toFixed(2)}% ueberschreitet das Sicherheitslimit von 100%.`);
  }
  return { ...config };
}

async function legacyFallback(guildId: string, nitradoConnId: string, type: CasinoGameKey): Promise<CasinoGameConfig | null> {
  if (type !== 'SLOT' && type !== 'COINFLIP' && type !== 'DICE' && type !== 'BLACKJACK') return null;
  const legacy = await prisma.casinoGame.findUnique({
    where: { guildServerType: { guildId, nitradoConnId, type } },
    select: { enabled: true, winChancePct: true, payoutMult: true, minBet: true, maxBet: true },
  });
  if (!legacy) return null;
  const defaults = DEFINITIONS[type].defaults;
  const candidate: CasinoGameConfig = {
    enabled: legacy.enabled,
    // Only SLOT used this field as an actual probability before V3. The fixed-rule
    // games start from their safe V3 probability instead of inheriting dead data.
    winChancePct: type === 'SLOT' ? legacy.winChancePct : defaults.winChancePct,
    payoutMult: legacy.payoutMult,
    minBet: legacy.minBet,
    maxBet: legacy.maxBet,
    cooldownSeconds: defaults.cooldownSeconds,
  };
  try {
    return validateCasinoConfig(type, candidate);
  } catch {
    return { ...defaults };
  }
}

export async function getCasinoGameConfig(
  guildId: string,
  nitradoConnId: string,
  type: CasinoGameKey,
): Promise<CasinoGameConfig> {
  const row = await prisma.botConfig.findUnique({
    where: { key: casinoConfigKey(guildId, nitradoConnId, type) },
    select: { value: true },
  });
  const stored = parseStoredConfig(type, row?.value);
  if (stored) return stored;
  return (await legacyFallback(guildId, nitradoConnId, type)) ?? { ...DEFINITIONS[type].defaults };
}

export async function listCasinoGameConfigs(guildId: string, nitradoConnId: string): Promise<Array<CasinoGameDefinition & { config: CasinoGameConfig }>> {
  return Promise.all(CASINO_GAME_KEYS.map(async type => ({
    ...casinoDefinition(type),
    config: await getCasinoGameConfig(guildId, nitradoConnId, type),
  })));
}

export async function saveCasinoGameConfig(
  guildId: string,
  nitradoConnId: string,
  type: CasinoGameKey,
  config: CasinoGameConfig,
): Promise<CasinoGameConfig> {
  const valid = validateCasinoConfig(type, config);
  const json: Prisma.InputJsonObject = {
    version: 3,
    enabled: valid.enabled,
    winChancePct: valid.winChancePct,
    payoutMult: valid.payoutMult,
    minBet: valid.minBet.toString(),
    maxBet: valid.maxBet.toString(),
    cooldownSeconds: valid.cooldownSeconds,
  };
  await prisma.botConfig.upsert({
    where: { key: casinoConfigKey(guildId, nitradoConnId, type) },
    create: {
      key: casinoConfigKey(guildId, nitradoConnId, type),
      value: json,
      category: 'casino-v3',
      description: `Casino V3 ${type} fuer ${guildId}/${nitradoConnId}`,
    },
    update: { value: json, category: 'casino-v3' },
  });

  // Keep the four legacy rows coherent for old reports/tools. They are no longer
  // the V3 source of truth, but preserving these values avoids split-brain reads
  // while the remaining dashboard/report paths are migrated.
  if (type === 'SLOT' || type === 'COINFLIP' || type === 'DICE' || type === 'BLACKJACK') {
    await prisma.casinoGame.upsert({
      where: { guildServerType: { guildId, nitradoConnId, type } },
      create: {
        guildId, nitradoConnId, type,
        enabled: valid.enabled,
        winChancePct: valid.winChancePct,
        payoutMult: valid.payoutMult,
        minBet: valid.minBet,
        maxBet: valid.maxBet,
      },
      update: {
        enabled: valid.enabled,
        winChancePct: valid.winChancePct,
        payoutMult: valid.payoutMult,
        minBet: valid.minBet,
        maxBet: valid.maxBet,
      },
    });
  }
  return valid;
}

/**
 * CasinoRound still references the historic CasinoGame table. New logical games
 * use a stable legacy anchor while the immutable result.audit.type carries the
 * real V3 identity. Existing rounds/FKs remain untouched.
 */
export async function ensureCasinoRoundAnchor(guildId: string, nitradoConnId: string, type: CasinoGameKey): Promise<string> {
  const anchorType = DEFINITIONS[type].anchorType;
  const defaults = DEFINITIONS[anchorType].defaults;
  const row = await prisma.casinoGame.upsert({
    where: { guildServerType: { guildId, nitradoConnId, type: anchorType } },
    create: {
      guildId,
      nitradoConnId,
      type: anchorType,
      enabled: false,
      winChancePct: defaults.winChancePct,
      payoutMult: defaults.payoutMult,
      minBet: defaults.minBet,
      maxBet: defaults.maxBet,
    },
    update: {},
    select: { id: true },
  });
  return row.id;
}
