import { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import { admBindingFileIdentityPrefix } from '../nitrado/adm/bindingState';
import {
  resolveOnlinePresence,
  type PlayerPositionEvent,
  type PlayerPresenceEvent,
} from '../gameplayFeeds/playerListRoster';
import {
  bookPlaytimeRewards,
  type PlaytimeBookingClient,
  type PlaytimeBookingScope,
  type ResolveRewardLinkFn,
} from './playtimeBooking';

export interface PlaytimeRewardOptions {
  perBucketAmount: bigint;
  rewardTarget: 'WALLET' | 'BANK';
  limit?: number;
  maxClosedPages?: number;
  now?: Date;
  payoutEnabled?: boolean;
}

/**
 * Ermittelt dieselbe aktuelle ADM-Roster-Wahrheit wie die PLAYER_LIST.
 * Historische PlayerSession.status=OPEN-Zeilen sind explizit keine Online-
 * Evidenz. Wenn noch kein aktueller Cursor existiert, gilt fail-closed: offene
 * Sessions werden nicht bezahlt; CLOSED-Historie bleibt davon unberuehrt.
 */
export async function loadLiveAdmGameIds(scope: PlaytimeBookingScope): Promise<Set<string>> {
  const binding = await prisma.nitradoAdmBindingState.findUnique({
    where: {
      guildId_nitradoConnId: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
      },
    },
    select: { bindingVersion: true },
  });
  const namespacePrefix = admBindingFileIdentityPrefix(binding?.bindingVersion ?? 0);
  const latestCursor = await prisma.admSourceCursor.findFirst({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      ...(namespacePrefix ? { fileIdentity: { startsWith: namespacePrefix } } : {}),
    },
    orderBy: [{ lastModifiedAt: 'desc' }, { fileName: 'desc' }],
    select: { fileIdentity: true },
  });
  if (!latestCursor) return new Set<string>();

  const presenceEvents = await prisma.$queryRaw<PlayerPresenceEvent[]>(Prisma.sql`
    SELECT DISTINCT ON ("actorGameId")
           "id", "eventType", "actorGameId", "actorName", "sourceByteStart"
      FROM "AdmEvent"
     WHERE "guildId" = ${scope.guildId}
       AND "nitradoConnId" = ${scope.nitradoConnId}
       AND "sourceFile" = ${latestCursor.fileIdentity}
       AND "actorGameId" IS NOT NULL
       AND "eventType" IN (
         'PLAYER_CONNECTED'::"AdmEventType",
         'PLAYER_DISCONNECTED'::"AdmEventType"
       )
     ORDER BY "actorGameId", "sourceByteStart" DESC, "id" DESC
  `);

  const positions = await prisma.$queryRaw<PlayerPositionEvent[]>(Prisma.sql`
    SELECT DISTINCT ON ("actorGameId")
           "id", "actorGameId", "actorName", "actorPosition", "sourceByteStart"
      FROM "AdmEvent"
     WHERE "guildId" = ${scope.guildId}
       AND "nitradoConnId" = ${scope.nitradoConnId}
       AND "sourceFile" = ${latestCursor.fileIdentity}
       AND "actorGameId" IS NOT NULL
       AND "actorPosition" IS NOT NULL
       AND "eventType" = 'PLAYER_POSITION'::"AdmEventType"
     ORDER BY "actorGameId", "sourceByteStart" DESC, "id" DESC
  `);

  return new Set(resolveOnlinePresence(presenceEvents, positions).map(player => player.gameId));
}

/**
 * Erzwingt die Live-Roster-Grenze nur fuer OPEN-Queries. CLOSED-Sessions laufen
 * unveraendert durch den bestehenden persistenten Reward-Cursor. Dadurch kann
 * eine historisch verwaiste OPEN-Sitzung niemals bis `now` weiterverdienen,
 * waehrend korrekt abgeschlossene Spielzeit weiterhin normal verarbeitet wird.
 */
export function restrictOpenSessionQuery(
  args: unknown,
  liveGameIds: ReadonlySet<string>,
): unknown {
  const query = args as { where?: Record<string, unknown> };
  if (query.where?.status !== 'OPEN') return args;
  return {
    ...query,
    where: {
      ...query.where,
      gameId: { in: [...liveGameIds] },
    },
  };
}

export async function bookPlaytimeRewardsWithLiveRoster(
  scope: PlaytimeBookingScope,
  opts: PlaytimeRewardOptions,
  resolveRewardLink: ResolveRewardLinkFn,
): Promise<{ credited: number; total: bigint }> {
  const liveGameIds = await loadLiveAdmGameIds(scope);
  const guardedClient = {
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => prisma.$transaction(tx => fn(tx)),
    rewardProcessingCursor: {
      upsert: (args: unknown) => prisma.rewardProcessingCursor.upsert(args as never),
      updateMany: (args: unknown) => prisma.rewardProcessingCursor.updateMany(args as never),
    },
    playerSession: {
      findMany: (args: unknown) => prisma.playerSession.findMany(restrictOpenSessionQuery(args, liveGameIds) as never),
    },
  } as unknown as PlaytimeBookingClient;

  return bookPlaytimeRewards(guardedClient, scope, opts, resolveRewardLink);
}
