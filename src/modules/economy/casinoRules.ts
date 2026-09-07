import type { CasinoGameType } from '@prisma/client';

export const CASINO_GAME_TYPES: readonly CasinoGameType[] = ['SLOT', 'COINFLIP', 'DICE', 'BLACKJACK'];
export const MAX_CASINO_BET = 1_000_000_000_000_000n;
export const CASINO_ALGORITHM_VERSION = 'HMAC_SHA256_REJECTION_V2';
export const MAX_THEORETICAL_RTP_PCT = 100;

export interface CasinoRuleDefaults {
  enabled: boolean;
  winChancePct: number;
  payoutMult: number;
  minBet: bigint;
  maxBet: bigint;
}

const DEFAULTS: Record<CasinoGameType, CasinoRuleDefaults> = {
  SLOT: { enabled: false, winChancePct: 45, payoutMult: 2, minBet: 1n, maxBet: 10_000n },
  COINFLIP: { enabled: false, winChancePct: 50, payoutMult: 1.9, minBet: 1n, maxBet: 10_000n },
  DICE: { enabled: false, winChancePct: 17, payoutMult: 5.5, minBet: 1n, maxBet: 10_000n },
  BLACKJACK: { enabled: false, winChancePct: 50, payoutMult: 2, minBet: 1n, maxBet: 10_000n },
};

// Exakte Zustandsraum-Auswertung der aktuellen vereinfachten Blackjack-Regel:
// beide Seiten ziehen bis Score >= 17, Kartenwerte 1..13 gleichverteilt mit
// Zuruecklegen; Player-Bust verliert auch dann, wenn der Dealer spaeter bustet.
const BLACKJACK_WIN_PROBABILITY = 0.4077323365714893;
const BLACKJACK_DRAW_PROBABILITY = 0.10524079516896465;

export function casinoDefaults(type: CasinoGameType): CasinoRuleDefaults {
  return { ...DEFAULTS[type] };
}

export function payoutMultiplierMilli(multiplier: number): number {
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 100) {
    throw new Error('Ungueltiger Auszahlungs-Multiplikator.');
  }
  return Math.round(multiplier * 1000);
}

export function theoreticalCasinoRtpPct(
  type: CasinoGameType,
  winChancePct: number,
  payoutMult: number,
): number {
  if (!Number.isFinite(payoutMult) || payoutMult < 0) return Number.POSITIVE_INFINITY;
  switch (type) {
    case 'SLOT':
      return (winChancePct / 100) * payoutMult * 100;
    case 'COINFLIP':
      return 0.5 * payoutMult * 100;
    case 'DICE':
      return (1 / 6) * payoutMult * 100;
    case 'BLACKJACK':
      return (BLACKJACK_WIN_PROBABILITY * payoutMult + BLACKJACK_DRAW_PROBABILITY) * 100;
  }
}

export function assertCasinoEconomySafe(
  type: CasinoGameType,
  winChancePct: number,
  payoutMult: number,
): number {
  const rtp = theoreticalCasinoRtpPct(type, winChancePct, payoutMult);
  if (!Number.isFinite(rtp) || rtp > MAX_THEORETICAL_RTP_PCT + 1e-9) {
    throw new Error(`Theoretischer RTP ${rtp.toFixed(2)}% ueberschreitet das Sicherheitslimit von ${MAX_THEORETICAL_RTP_PCT.toFixed(0)}%.`);
  }
  return rtp;
}
