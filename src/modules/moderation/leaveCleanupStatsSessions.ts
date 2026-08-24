import { createHmac } from 'node:crypto';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { identityHash } from '../linking/identity';

const SESSION_PAGE_SIZE = 1000;
const PLAYER_SUBJECT_PREFIX = 'ps1_';

export type LeaveStatsSessionsState = 'DONE' | 'WAITING';
export type LeaveStatsSessionsReason = 'ACTIVE_SESSION';

export interface LeaveStatsSessionsResult {
  state: LeaveStatsSessionsState;
  reason?: LeaveStatsSessionsReason;
  links: number;
  gameIdentities: number;
  sessionsPseudonymized: number;
  admEventsPseudonymized: number;
  levelRowsDeleted: number;
  xpRowsDeleted: number;
}

interface SessionEvidence {
  id: string;
  gameId: string;
  playerName: string | null;
  status: 'OPEN' | 'CLOSED';
}

interface TargetIdentity {
  nitradoConnId: string;
  rawGameId: string;
  subjectKey: string;
}

interface RawClient {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

function rawClient(value: unknown): RawClient {
  return value as RawClient;
}

function cleanScopePart(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 128 || /[\r\n\t]/.test(trimmed)) {
    throw new Error(`${label} muss ein nicht-leerer Scope-Identifier mit max. 128 Zeichen sein.`);
  }
  return trimmed;
}

/**
 * Stabiler, guild- und gameserver-gescoppter Pseudonym-Key fuer historische
 * DayZ-Session-/ADM-Beweise. Der originale Game-Identifier bleibt daraus nicht
 * rekonstruierbar und der Key ist nicht guilduebergreifend korrelierbar.
 */
export function leavePlayerSubjectKey(
  guildId: string,
  nitradoConnId: string,
  linkIdentityHash: string,
  secret: string,
): string {
  const guild = cleanScopePart(guildId, 'guildId');
  const connection = cleanScopePart(nitradoConnId, 'nitradoConnId');
  const hash = linkIdentityHash.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Leave-Player-IdentityHash ist ungueltig.');
  if (secret.length < 32) throw new Error('Leave-Player-HMAC-Secret ist zu kurz.');
  const digest = createHmac('sha256', secret)
    .update(`leave-player:v1:${guild}:${connection}:${hash}`)
    .digest('hex')
    .slice(0, 32);
  return `${PLAYER_SUBJECT_PREFIX}${digest}`;
}

async function listSessionEvidence(guildId: string, nitradoConnId: string): Promise<SessionEvidence[]> {
  const rows: SessionEvidence[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await prisma.playerSession.findMany({
      where: { guildId, nitradoConnId },
      select: { id: true, gameId: true, playerName: true, status: true },
      orderBy: { id: 'asc' },
      take: SESSION_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }) as SessionEvidence[];
    rows.push(...page);
    if (page.length < SESSION_PAGE_SIZE) break;
    cursor = page[page.length - 1].id;
  }

  return rows;
}

function waitingResult(links: number, gameIdentities: number): LeaveStatsSessionsResult {
  return {
    state: 'WAITING',
    reason: 'ACTIVE_SESSION',
    links,
    gameIdentities,
    sessionsPseudonymized: 0,
    admEventsPseudonymized: 0,
    levelRowsDeleted: 0,
    xpRowsDeleted: 0,
  };
}

/**
 * Leave-1D — interner, noch NICHT produktiv verdrahteter Saga-Schritt.
 *
 * Muss spaeter VOR Leave-1C laufen, weil die verifizierten GameIdentityLinks
 * hier noch als kryptografische Zuordnung fuer die Session-GUIDs gebraucht
 * werden. Eine OPEN-Session blockiert fail-closed: ein Disconnect darf niemals
 * durch eine vorzeitige Pseudonymisierung unpaarbar werden.
 *
 * Geschlossene PlayerSessions bleiben als Anti-Replay-/Reward-Beweis erhalten;
 * nur Game-Identifier und Spielername werden entkoppelt. AdmEvent-IDs, eventKey,
 * Zeitstempel und Feed-Cursor bleiben bestehen, waehrend die personenbezogenen
 * Identitaetsfelder und die rohe ADM-Zeile pseudonymisiert werden. Discord-XP,
 * Level und Economy gehoeren ausdruecklich nicht zum normalen Leave-Cleanup.
 */
export async function runLeaveStatsSessionsCleanupStep(
  guildId: string,
  userDiscordId: string,
): Promise<LeaveStatsSessionsResult> {
  const secret = config.security.encryptionKey;
  const links = await prisma.gameIdentityLink.findMany({
    where: {
      guildId,
      userDiscordId,
      status: 'VERIFIED',
      identityHash: { not: null },
    },
    select: { nitradoConnId: true, identityHash: true },
    orderBy: { createdAt: 'asc' },
  });

  const targetsByKey = new Map<string, TargetIdentity>();
  let gameIdentities = 0;

  for (const link of links) {
    if (!link.identityHash) throw new Error('Leave-Stats: VERIFIED Link ohne identityHash.');
    gameIdentities++;
    const subjectKey = leavePlayerSubjectKey(guildId, link.nitradoConnId, link.identityHash, secret);
    const sessions = await listSessionEvidence(guildId, link.nitradoConnId);
    let evidenceFound = false;

    for (const session of sessions) {
      if (session.gameId === subjectKey) {
        evidenceFound = true;
        continue;
      }
      if (identityHash(session.gameId, secret) !== link.identityHash) continue;
      evidenceFound = true;
      if (session.status === 'OPEN') return waitingResult(links.length, gameIdentities);
      const key = `${link.nitradoConnId}\u0000${session.gameId}`;
      targetsByKey.set(key, {
        nitradoConnId: link.nitradoConnId,
        rawGameId: session.gameId,
        subjectKey,
      });
    }

    if (!evidenceFound) {
      // Ohne Session-Evidenz existiert kein sicher zuordenbares Statistikziel.
      // Fail-closed bedeutet hier: nichts mutieren und nicht auf eine fremde
      // Identitaet raten. Der Goodbye-Status bleibt entsprechend grau.
      continue;
    }
  }

  const targets = Array.from(targetsByKey.values());
  const txResult = await prisma.$transaction(async tx => {
    const trx = rawClient(tx);

    if (targets.length > 0) {
      // Seltene Leave-Operation: kurze Tabellenlocks verhindern, dass zwischen
      // OPEN-Recheck und Pseudonymisierung neue Session-/ADM-Zeilen einschieben.
      await trx.$executeRawUnsafe('LOCK TABLE "PlayerSession" IN SHARE ROW EXCLUSIVE MODE');
      await trx.$executeRawUnsafe('LOCK TABLE "AdmEvent" IN SHARE ROW EXCLUSIVE MODE');

      for (const target of targets) {
        const open = await trx.$queryRawUnsafe<Array<{ id: string }>>(
          `SELECT "id" FROM "PlayerSession"
            WHERE "guildId"=$1
              AND "nitradoConnId"=$2
              AND "gameId"=$3
              AND "status"='OPEN'::"PlayerSessionStatus"
            LIMIT 1`,
          guildId,
          target.nitradoConnId,
          target.rawGameId,
        );
        if (open.length > 0) return { waiting: true as const };
      }
    }

    let sessionsPseudonymized = 0;
    let admEventsPseudonymized = 0;

    for (const target of targets) {
      sessionsPseudonymized += await trx.$executeRawUnsafe(
        `UPDATE "PlayerSession"
            SET "gameId"=$4,
                "playerName"=NULL,
                "updatedAt"=CURRENT_TIMESTAMP
          WHERE "guildId"=$1
            AND "nitradoConnId"=$2
            AND "gameId"=$3
            AND "status"='CLOSED'::"PlayerSessionStatus"`,
        guildId,
        target.nitradoConnId,
        target.rawGameId,
        target.subjectKey,
      );

      admEventsPseudonymized += await trx.$executeRawUnsafe(
        `UPDATE "AdmEvent"
            SET "rawLine"='[LEAVE_RESET] eventKey=' || "eventKey",
                "actorGameId"=CASE WHEN "actorGameId"=$3 THEN $4 ELSE "actorGameId" END,
                "actorName"=CASE WHEN "actorGameId"=$3 THEN NULL ELSE "actorName" END,
                "targetGameId"=CASE WHEN "targetGameId"=$3 THEN $4 ELSE "targetGameId" END,
                "targetName"=CASE WHEN "targetGameId"=$3 THEN NULL ELSE "targetName" END
          WHERE "guildId"=$1
            AND "nitradoConnId"=$2
            AND ("actorGameId"=$3 OR "targetGameId"=$3)`,
        guildId,
        target.nitradoConnId,
        target.rawGameId,
        target.subjectKey,
      );
    }

    return {
      waiting: false as const,
      sessionsPseudonymized,
      admEventsPseudonymized,
      levelRowsDeleted: 0,
      xpRowsDeleted: 0,
    };
  });

  if (txResult.waiting) return waitingResult(links.length, gameIdentities);

  return {
    state: 'DONE',
    links: links.length,
    gameIdentities,
    sessionsPseudonymized: txResult.sessionsPseudonymized,
    admEventsPseudonymized: txResult.admEventsPseudonymized,
    levelRowsDeleted: txResult.levelRowsDeleted,
    xpRowsDeleted: txResult.xpRowsDeleted,
  };
}
