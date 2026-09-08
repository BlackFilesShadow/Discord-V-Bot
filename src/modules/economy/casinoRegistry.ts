import type { CasinoGameType } from '@prisma/client';
import prisma from '../../database/prisma';

/**
 * Casino V3 registry.
 *
 * Public game identity is intentionally independent from Prisma's historic
 * four-value CasinoGameType enum. CasinoGameConfigV3 is the server-scoped V3
 * source of truth; legacy CasinoGame rows remain stable CasinoRound FK anchors
 * and compatibility mirrors for the original four games.
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

/** Runtime payouts are stored as milli-multipliers; config uses the exact same precision. */
export function normalizeCasinoPayoutMultiplier(value: number): number {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1000) / 1000;
}

export function theoreticalCasinoRtpPct(type: CasinoGameKey, winChancePct: number, payoutMult: number): number {
  const def = DEFINITIONS[type];
  const win = winChancePct / 100;
  const nonWin = 1 - win;
  const conditionalDraw = def.drawConditionalPct / 100;
  const normalizedPayout = normalizeCasinoPayoutMultiplier(payoutMult);
  return (win * normalizedPayout + nonWin * conditionalDraw) * 100;
}

export function validateCasinoConfig(type: CasinoGameKey, config: CasinoGameConfig): CasinoGameConfig {
  if (!Number.isInteger(config.winChancePct) || config.winChancePct < 1 || config.winChancePct > 99) {
    throw new Error('Gewinnchance muss eine ganze Zahl von 1 bis 99 Prozent sein.');
  }
  const payoutMult = normalizeCasinoPayoutMultiplier(config.payoutMult);
  if (!Number.isFinite(payoutMult) || payoutMult < 1 || payoutMult > 100) {
    throw new Error('Auszahlung muss zwischen x1 und x100 liegen.');
  }
  if (config.minBet < 1n || config.minBet > MAX_CONFIG_BET) throw new Error('Mindesteinsatz ist ungueltig.');
  if (config.maxBet < config.minBet || config.maxBet > MAX_CONFIG_BET) throw new Error('Maximaleinsatz ist ungueltig.');
  if (!Number.isInteger(config.cooldownSeconds) || config.cooldownSeconds < 0 || config.cooldownSeconds > 3_600) {
    throw new Error('Cooldown muss zwischen 0 und 3600 Sekunden liegen.');
  }
  const normalized = { ...config, payoutMult };
  const rtp = theoreticalCasinoRtpPct(type, normalized.winChancePct, normalized.payoutMult);
  if (!Number.isFinite(rtp) || rtp > 100 + 1e-9) {
    throw new Error(`Theoretischer RTP ${rtp.toFixed(2)}% ueberschreitet das Sicherheitslimit von 100%.`);
  }
  return normalized;
}

function configFromStoredRow(type: CasinoGameKey, row: {
  enabled: boolean;
  winChancePct: number;
  payoutMult: number;
  minBet: bigint;
  maxBet: bigint;
  cooldownSeconds: number;
}): CasinoGameConfig | null {
  try {
    return validateCasinoConfig(type, {
      enabled: row.enabled,
      winChancePct: row.winChancePct,
      payoutMult: row.payoutMult,
      minBet: row.minBet,
      maxBet: row.maxBet,
      cooldownSeconds: row.cooldownSeconds,
    });
  } catch {
    return null;
  }
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
    // Before V3 only SLOT treated winChancePct as actual probability. Fixed-rule
    // legacy games start with their safe V3 defaults instead of inheriting dead data.
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
  const row = await prisma.casinoGameConfigV3.findUnique({
    where: { guildServerType: { guildId, nitradoConnId, type } },
    select: {
      enabled: true,
      winChancePct: true,
      payoutMult: true,
      minBet: true,
      maxBet: true,
      cooldownSeconds: true,
    },
  });
  const stored = row ? configFromStoredRow(type, row) : null;
  if (stored) return stored;
  return (await legacyFallback(guildId, nitradoConnId, type)) ?? { ...DEFINITIONS[type].defaults };
}

export async function listCasinoGameConfigs(
  guildId: string,
  nitradoConnId: string,
): Promise<Array<CasinoGameDefinition & { config: CasinoGameConfig }>> {
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

  await prisma.$transaction(async tx => {
    await tx.casinoGameConfigV3.upsert({
      where: { guildServerType: { guildId, nitradoConnId, type } },
      create: {
        guildId,
        nitradoConnId,
        type,
        enabled: valid.enabled,
        winChancePct: valid.winChancePct,
        payoutMult: valid.payoutMult,
        minBet: valid.minBet,
        maxBet: valid.maxBet,
        cooldownSeconds: valid.cooldownSeconds,
      },
      update: {
        enabled: valid.enabled,
        winChancePct: valid.winChancePct,
        payoutMult: valid.payoutMult,
        minBet: valid.minBet,
        maxBet: valid.maxBet,
        cooldownSeconds: valid.cooldownSeconds,
      },
    });

    // Keep the original four rows coherent for legacy reports/tools. Both writes
    // commit atomically so there is no transient split-brain configuration.
    if (type === 'SLOT' || type === 'COINFLIP' || type === 'DICE' || type === 'BLACKJACK') {
      await tx.casinoGame.upsert({
        where: { guildServerType: { guildId, nitradoConnId, type } },
        create: {
          guildId,
          nitradoConnId,
          type,
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
  });
  return valid;
}

/**
 * CasinoRound still references the historic CasinoGame table. New logical games
 * use a stable legacy anchor while immutable result.audit.type carries the V3
 * identity. Existing round rows and foreign keys therefore remain untouched.
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
