import {
  CASINO_GAME_KEYS,
  casinoDefinition,
  theoreticalCasinoRtpPct as registryRtp,
  type CasinoGameConfig,
  type CasinoGameKey,
} from './casinoRegistry';

export const CASINO_GAME_TYPES: readonly CasinoGameKey[] = CASINO_GAME_KEYS;
export const MAX_CASINO_BET = 1_000_000_000_000_000n;
export const CASINO_ALGORITHM_VERSION = 'HMAC_SHA256_REJECTION_V3_CONFIGURED_ODDS';
export const LEGACY_CASINO_ALGORITHM_VERSION = 'HMAC_SHA256_REJECTION_V2';
export const MAX_THEORETICAL_RTP_PCT = 100;

export interface CasinoRuleDefaults extends CasinoGameConfig {}

export function casinoDefaults(type: CasinoGameKey): CasinoRuleDefaults {
  return { ...casinoDefinition(type).defaults };
}

export function payoutMultiplierMilli(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 100) {
    throw new Error('Ungueltiger Auszahlungs-Multiplikator.');
  }
  return Math.round(multiplier * 1000);
}

/**
 * V3 uses the configured win chance for every public game. Rule-based games may
 * additionally refund a small conditional draw share; that share is part of the
 * registry and therefore included in RTP instead of being hidden from admins.
 */
export function theoreticalCasinoRtpPct(
  type: CasinoGameKey,
  winChancePct: number,
  payoutMult: number,
): number {
  return registryRtp(type, winChancePct, payoutMult);
}

export function assertCasinoEconomySafe(
  type: CasinoGameKey,
  winChancePct: number,
  payoutMult: number,
): number {
  const rtp = theoreticalCasinoRtpPct(type, winChancePct, payoutMult);
  if (!Number.isFinite(rtp) || rtp > MAX_THEORETICAL_RTP_PCT + 1e-9) {
    throw new Error(`Theoretischer RTP ${rtp.toFixed(2)}% ueberschreitet das Sicherheitslimit von ${MAX_THEORETICAL_RTP_PCT.toFixed(0)}%.`);
  }
  return rtp;
}

export type { CasinoGameKey };
