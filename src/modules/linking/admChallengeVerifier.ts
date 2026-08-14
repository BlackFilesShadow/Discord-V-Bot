/**
 * Phase 7 LINK-002: verbindet den kurzlebigen /link-Challenge-Code mit der
 * kanonischen ADM-Pipeline, ohne ein plattformspezifisches Chatformat zu
 * erfinden.
 *
 * Eine Zeile ist nur Kandidat, wenn sie BEIDES enthaelt:
 *   - eine Spielidentitaet in der bereits im ADM-Parser verwendeten Form id=...
 *   - einen eigenstaendigen 8-stelligen Challenge-Code
 *
 * Ob der Code wirklich gueltig ist, entscheidet ausschliesslich verifyByCode()
 * gegen die persistente PENDING-Challenge. Klartext-Spielidentitaeten werden
 * weder gespeichert noch geloggt.
 */

import { verifyByCode, type LinkClient, type LinkScope } from './linkService';

const GAME_ID_RE = /\bid=([^\s,)]+)/i;
const CHALLENGE_CANDIDATE_RE = /\b([A-Z2-9]{8})\b/g;

export interface AdmChallengeVerificationSummary {
  candidates: number;
  verified: number;
}

export async function verifyLinkChallengesInAdmText(
  client: LinkClient,
  scope: LinkScope,
  content: string,
  secret: string,
  now: Date = new Date(),
): Promise<AdmChallengeVerificationSummary> {
  let candidates = 0;
  let verified = 0;

  for (const line of content.split(/\r?\n/)) {
    const gameId = GAME_ID_RE.exec(line)?.[1];
    if (!gameId) continue;

    const upper = line.toUpperCase();
    const codes = new Set<string>();
    let match: RegExpExecArray | null;
    CHALLENGE_CANDIDATE_RE.lastIndex = 0;
    while ((match = CHALLENGE_CANDIDATE_RE.exec(upper)) !== null) codes.add(match[1]);

    for (const code of codes) {
      candidates++;
      const result = await verifyByCode(client, scope, code, gameId, secret, now);
      if (result.verified) {
        verified++;
        // Eine Spielzeile soll hoechstens eine Challenge erfolgreich erfuellen.
        break;
      }
    }
  }

  return { candidates, verified };
}
