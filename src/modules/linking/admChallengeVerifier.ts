/**
 * Legacy-Kompatibilitaet fuer den frueheren Ingame-Chat-Challenge-Flow.
 *
 * Konsolen-Spieler koennen den alten Verifikationscode nicht verlaesslich in
 * einen DayZ-Ingame-Chat schreiben. Die produktive Verknuepfung erfolgt daher
 * ausschliesslich ueber /link + exakten Spielernamen + mindestens 5 Minuten
 * PlayerSession-Nachweis. Diese Funktion bleibt vorerst als no-op erhalten,
 * damit der ADM-Live-Sync ohne riskanten Parallelumbau kompatibel bleibt.
 */

import type { LinkClient, LinkScope } from './linkService';

export interface AdmChallengeVerificationSummary {
  candidates: number;
  verified: number;
}

export async function verifyLinkChallengesInAdmText(
  _client: LinkClient,
  _scope: LinkScope,
  _content: string,
  _secret: string,
  _now: Date = new Date(),
): Promise<AdmChallengeVerificationSummary> {
  return { candidates: 0, verified: 0 };
}
