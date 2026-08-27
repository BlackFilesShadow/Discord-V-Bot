import prisma from '../../database/prisma';
import { config } from '../../config';
import { identityHash } from '../linking/identity';
import { readLeaveCleanupDetails } from '../moderation/leaveCleanupSaga';
import {
  enqueueWhitelistAdd,
  enqueueWhitelistRemove,
  type WhitelistOutboxClient,
} from '../whitelist/whitelistOutbox';
import { isAuthorizedWhitelistRemovePayload } from '../whitelist/whitelistJobSafety';

export type WhitelistJobOperation = 'WHITELIST_ADD' | 'WHITELIST_REMOVE';
export type WhitelistDesiredState = 'PRESENT' | 'PENDING_REMOVE' | 'UNTRACKED';
export type WhitelistIntentReason =
  | 'CURRENT_INTENT'
  | 'SUPERSEDED_BY_REMOVE'
  | 'SUPERSEDED_BY_PRESENT'
  | 'UNTRACKED_REMOVE_NOT_AUTHORIZED';

export interface WhitelistIntentDecision {
  execute: boolean;
  desiredState: WhitelistDesiredState;
  reason: WhitelistIntentReason;
}

export interface WhitelistIntentReconciliation extends WhitelistIntentDecision {
  compensationQueued: boolean;
}

const SESSION_PAGE_SIZE = 1000;

function norm(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function payloadGameId(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const gameId = (value as Record<string, unknown>).gameId;
  return typeof gameId === 'string' && gameId.trim() ? gameId.trim() : null;
}

/**
 * Liest unmittelbar vor oder nach einem Remote-Whitelist-Write die aktuelle
 * Source-of-Truth fuer exakt Guild + Gameserver + Spielernamen.
 *
 * Mehrere case-variierte Legacy-Zeilen werden konservativ zusammengefuehrt:
 * sobald irgendeine passende Zeile aktiv ist, gilt PRESENT. Nur wenn keine
 * aktive Zeile existiert, aber mindestens eine PENDING_REMOVE-Zeile, gilt der
 * Entfernen-Wunsch. Ohne lokale Zeile ist der Zustand UNTRACKED und damit fuer
 * REMOVE grundsaetzlich fail-closed.
 */
export async function readWhitelistDesiredState(
  guildId: string,
  nitradoConnId: string,
  rawGameId: string,
): Promise<WhitelistDesiredState> {
  const gameId = rawGameId.trim();
  if (!gameId) throw new Error('Whitelist-Intent: leerer Gameserver-Identifier.');
  const target = norm(gameId);

  const rows = await prisma.whitelistEntry.findMany({
    where: { guildId, nitradoConnId },
    select: { gameId: true, syncState: true },
  });
  const matching = rows.filter(row => norm(row.gameId) === target);

  if (matching.some(row => row.syncState !== 'PENDING_REMOVE')) return 'PRESENT';
  if (matching.some(row => row.syncState === 'PENDING_REMOVE')) return 'PENDING_REMOVE';
  return 'UNTRACKED';
}

async function listSessionEvidenceForName(
  guildId: string,
  nitradoConnId: string,
  target: string,
): Promise<Array<{ gameId: string; playerName: string | null }>> {
  const matches: Array<{ gameId: string; playerName: string | null }> = [];
  let cursor: string | undefined;

  // Sicherheits-Provenienz darf nicht von einem "letzte 5000"-Fenster
  // abhaengen. Ein lange inaktiver, verifiziert gelinkter Spieler bleibt ein
  // gueltiges Remove-Ziel; deshalb wird die komplette History stabil paginiert.
  for (;;) {
    const page = await prisma.playerSession.findMany({
      where: { guildId, nitradoConnId },
      select: { id: true, gameId: true, playerName: true },
      orderBy: { id: 'asc' },
      take: SESSION_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const session of page) {
      if (session.gameId && session.playerName && norm(session.playerName) === target) {
        matches.push({ gameId: session.gameId, playerName: session.playerName });
      }
    }
    if (page.length < SESSION_PAGE_SIZE) break;
    cursor = page[page.length - 1]?.id;
    if (!cursor) break;
  }

  return matches;
}

/**
 * Zweite, unabhaengige Sicherheitsgrenze fuer den einzigen legitimen Fall, in
 * dem ein Spieler remote auf der Whitelist stehen kann, obwohl lokal noch kein
 * WhitelistEntry existiert: der aktive Bye-Cleanup eines verifizierten Users.
 *
 * Ein Marker im NitradoJob allein reicht AUSDRUECKLICH NICHT. Fuer exakt den
 * angeforderten Namen muessen gleichzeitig gelten:
 * - genau ein passender markierter RUNNING-Remove-Job,
 * - eine aktive Leave-Cleanup-Saga dieser Guild im WHITELIST-Step,
 * - ein VERIFIED GameIdentityLink desselben Discord-Users auf diesem Server,
 * - eine PlayerSession, deren GUID-HMAC zu diesem Link gehoert und deren
 *   Playername exakt dem Remove-Ziel entspricht.
 *
 * Mehrdeutige Provenienz (zwei Leave-User fuer denselben Namen) failt geschlossen.
 */
async function hasAuthorizedVerifiedLeaveRemoveIntent(
  guildId: string,
  nitradoConnId: string,
  rawGameId: string,
): Promise<boolean> {
  const target = norm(rawGameId);
  const running = await prisma.nitradoJob.findMany({
    where: {
      guildId,
      nitradoConnId,
      operation: 'WHITELIST_REMOVE',
      status: 'RUNNING',
    },
    select: { payload: true },
  });
  const matchingJobs = running.filter(job => {
    const gameId = payloadGameId(job.payload);
    return gameId !== null && norm(gameId) === target;
  });
  if (matchingJobs.length !== 1 || !isAuthorizedWhitelistRemovePayload(matchingJobs[0].payload)) {
    return false;
  }

  const leaveRequests = await prisma.dataDeletionRequest.findMany({
    where: {
      requestType: 'PARTIAL_DELETION',
      status: 'IN_PROGRESS',
      details: { path: ['guildId'], equals: guildId },
    },
    select: { discordId: true, details: true },
    take: 500,
  });
  const activeDiscordIds = [...new Set(
    leaveRequests
      .filter(row => {
        const details = readLeaveCleanupDetails(row.details);
        return details?.guildId === guildId
          && details.step === 'WHITELIST'
          && details.stage === 'RUNNING';
      })
      .map(row => row.discordId),
  )];
  if (activeDiscordIds.length === 0) return false;

  const links = await prisma.gameIdentityLink.findMany({
    where: {
      guildId,
      nitradoConnId,
      userDiscordId: { in: activeDiscordIds },
      status: 'VERIFIED',
      identityHash: { not: null },
    },
    select: { userDiscordId: true, identityHash: true },
  });
  if (links.length === 0) return false;

  const sessions = await listSessionEvidenceForName(guildId, nitradoConnId, target);

  const provenDiscordIds = new Set<string>();
  for (const session of sessions) {
    const sessionIdentityHash = identityHash(session.gameId, config.security.encryptionKey);
    for (const link of links) {
      if (link.identityHash === sessionIdentityHash) provenDiscordIds.add(link.userDiscordId);
    }
  }

  return provenDiscordIds.size === 1;
}

/**
 * Entscheidet die Remote-Ausfuehrung ausschliesslich nach dem AKTUELLEN lokalen
 * Sollzustand plus der verifizierten Bye-Provenienz fuer den Sonderfall
 * UNTRACKED. Aktivierung, Sync, Reconcile oder ein Job-Marker allein duerfen
 * niemals einen remote-only Namen loeschen.
 *
 * ADD:
 *   PRESENT        -> ausfuehren
 *   PENDING_REMOVE -> stale/superseded
 *   UNTRACKED      -> stale/superseded
 *
 * REMOVE:
 *   PRESENT        -> stale/superseded
 *   PENDING_REMOVE -> ausfuehren
 *   UNTRACKED      -> nur fuer exakt verifizierten aktiven Bye-Cleanup
 */
export async function decideWhitelistRemoteIntent(
  operation: WhitelistJobOperation,
  guildId: string,
  nitradoConnId: string,
  gameId: string,
): Promise<WhitelistIntentDecision> {
  const desiredState = await readWhitelistDesiredState(guildId, nitradoConnId, gameId);

  if (operation === 'WHITELIST_ADD') {
    return desiredState === 'PRESENT'
      ? { execute: true, desiredState, reason: 'CURRENT_INTENT' }
      : { execute: false, desiredState, reason: 'SUPERSEDED_BY_REMOVE' };
  }

  if (desiredState === 'PRESENT') {
    return { execute: false, desiredState, reason: 'SUPERSEDED_BY_PRESENT' };
  }
  if (desiredState === 'PENDING_REMOVE') {
    return { execute: true, desiredState, reason: 'CURRENT_INTENT' };
  }

  const authorized = await hasAuthorizedVerifiedLeaveRemoveIntent(guildId, nitradoConnId, gameId);
  return authorized
    ? { execute: true, desiredState, reason: 'CURRENT_INTENT' }
    : { execute: false, desiredState, reason: 'UNTRACKED_REMOVE_NOT_AUTHORIZED' };
}

/**
 * Nitrado-1B Recovery-Grenze.
 *
 * Ist der historische Job inzwischen superseded, reicht ein lokales DONE nicht:
 * ein frueherer Versuch kann den Remote-Write bereits erfolgreich ausgefuehrt
 * und danach vor dem DONE-Checkpoint gecrasht haben. Deshalb wird unter der
 * atomaren Nitrado-1A-Outbox-Grenze zuerst der aktuelle Gegen-Intent garantiert.
 *
 * Ein nicht verifiziertes UNTRACKED-REMOVE ist davon absichtlich ausgenommen:
 * Es darf weder remote loeschen noch durch einen spekulativen ADD kompensiert
 * werden. Der sichere Zustand ist ein write-freier No-op.
 */
export async function reconcileWhitelistRemoteIntent(
  operation: WhitelistJobOperation,
  guildId: string,
  nitradoConnId: string,
  gameId: string,
): Promise<WhitelistIntentReconciliation> {
  const decision = await decideWhitelistRemoteIntent(operation, guildId, nitradoConnId, gameId);
  if (decision.execute) {
    return { ...decision, compensationQueued: false };
  }

  if (decision.reason === 'UNTRACKED_REMOVE_NOT_AUTHORIZED') {
    return { ...decision, compensationQueued: false };
  }

  const scope = { guildId, nitradoConnId };
  const outbox = prisma as unknown as WhitelistOutboxClient;
  const compensationQueued = operation === 'WHITELIST_ADD'
    ? await enqueueWhitelistRemove(outbox, scope, gameId)
    : await enqueueWhitelistAdd(outbox, scope, gameId);

  return { ...decision, compensationQueued };
}
