import prisma from '../../database/prisma';
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
 * REMOVE zunaechst fail-closed.
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

/**
 * Ein UNTRACKED-REMOVE darf nur dann remote laufen, wenn exakt der gerade
 * RUNNING befindliche Job fuer denselben Namen den neuen Outbox-Safety-Marker
 * traegt. Mehrdeutige parallele RUNNING-Jobs fuer denselben Namen sind bewusst
 * fail-closed.
 */
async function hasAuthorizedRunningRemoveIntent(
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
  const matching = running.filter(job => {
    const gameId = payloadGameId(job.payload);
    return gameId !== null && norm(gameId) === target;
  });
  return matching.length === 1 && isAuthorizedWhitelistRemovePayload(matching[0].payload);
}

/**
 * Entscheidet die Remote-Ausfuehrung ausschliesslich nach dem AKTUELLEN lokalen
 * Sollzustand plus einer expliziten Safety-Grenze fuer remote-only Removes.
 *
 * ADD:
 *   PRESENT        -> ausfuehren
 *   PENDING_REMOVE -> stale/superseded
 *   UNTRACKED      -> stale/superseded
 *
 * REMOVE:
 *   PRESENT        -> stale/superseded
 *   PENDING_REMOVE -> ausfuehren
 *   UNTRACKED      -> nur mit exakt einem markierten RUNNING-Job ausfuehren
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

  const authorized = await hasAuthorizedRunningRemoveIntent(guildId, nitradoConnId, gameId);
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
 * Ein unmarkierter UNTRACKED-REMOVE ist davon absichtlich ausgenommen: Er darf
 * weder remote loeschen noch durch einen spekulativen ADD kompensiert werden.
 * Der sichere Zustand ist ein write-freier No-op.
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
