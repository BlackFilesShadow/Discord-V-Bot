/**
 * GameIdentity-Primitive (Phase 7, LINK-001).
 *
 * Die Spielidentitaet (Steam64 / DAYZ-GUID) wird NIEMALS im Klartext gespeichert
 * oder geloggt — nur als HMAC-SHA256 (`identityHash`). Der Hash ist
 * deterministisch (fuer Lookup), aber der Klartext ist daraus nicht
 * rekonstruierbar. Verifikation laeuft ueber einen kurzlebigen In-Game-Chat-Code.
 */

import { createHmac, randomInt } from 'crypto';

const CHALLENGE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // ohne O/0/I/1
export const CHALLENGE_LENGTH = 8;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 Minuten

/** HMAC-SHA256 der Spielidentitaet, namespaced. */
export function identityHash(gameId: string, secret: string): string {
  return createHmac('sha256', secret).update(`gameid:${gameId.trim()}`).digest('hex');
}

/** Gut lesbarer Verifikations-Code fuer den In-Game-Chat. */
export function newChallengeCode(): string {
  let out = '';
  for (let i = 0; i < CHALLENGE_LENGTH; i++) out += CHALLENGE_ALPHABET[randomInt(CHALLENGE_ALPHABET.length)];
  return out;
}

/** Anzeige-/Log-Kurzform — NIE der volle GUID, nur ein Hash-Praefix. */
export function redactIdentity(hash: string): string {
  return `id:${hash.slice(0, 8)}`;
}

export interface ChallengeLike {
  status: 'PENDING' | 'VERIFIED' | 'UNLINKED';
  challengeCode: string | null;
  challengeExpiresAt: Date | null;
}

/** Erfuellt ein eingegebener Code eine offene, nicht abgelaufene Challenge? */
export function isChallengeValid(link: ChallengeLike, inputCode: string, now: Date): boolean {
  return link.status === 'PENDING'
    && !!link.challengeCode
    && link.challengeCode === inputCode.trim().toUpperCase()
    && !!link.challengeExpiresAt
    && link.challengeExpiresAt.getTime() > now.getTime();
}
