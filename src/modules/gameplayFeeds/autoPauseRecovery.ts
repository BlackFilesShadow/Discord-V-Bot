import { GameplayFeedKind } from '@prisma/client';
import prisma from '../../database/prisma';
import {
  BUILD_EVENT_TYPES,
  DEATH_EVENT_TYPES,
  KILL_EVENT_TYPES,
} from './types';

export const NITRADO_AUTO_PAUSE_REASON = 'NITRADO_INACTIVE';

interface GameplayFeedRecoveryScope {
  guildId: string;
  nitradoConnId: string;
}

function admEventTypesForRecovery(kind: GameplayFeedKind): string[] {
  if (kind === GameplayFeedKind.KILL) return [...KILL_EVENT_TYPES];
  if (kind === GameplayFeedKind.DEATH) return [...DEATH_EVENT_TYPES];
  if (kind === GameplayFeedKind.PLACEMENT) return ['PLACEMENT'];
  if (kind === GameplayFeedKind.BUILD) {
    return [...BUILD_EVENT_TYPES].filter(type => type !== 'PLACEMENT');
  }
  return [];
}

async function recoveryWatermark(
  scope: GameplayFeedRecoveryScope,
  kind: GameplayFeedKind,
  now: Date,
): Promise<{ createdAt: Date; id: string }> {
  if (kind === GameplayFeedKind.PLAYER_LIST) return { createdAt: now, id: '' };

  if (kind === GameplayFeedKind.FLAG) {
    const latest = await prisma.flagActivityEvent.findFirst({
      where: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: { createdAt: true, id: true },
    });
    return latest ?? { createdAt: now, id: '' };
  }

  const eventTypes = admEventTypesForRecovery(kind);
  const latest = eventTypes.length === 0
    ? null
    : await prisma.admEvent.findFirst({
        where: {
          guildId: scope.guildId,
          nitradoConnId: scope.nitradoConnId,
          eventType: { in: eventTypes as any },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { createdAt: true, id: true },
      });
  return latest ?? { createdAt: now, id: '' };
}

/**
 * Reaktiviert ausschliesslich Feeds, die V-Bot selbst wegen einer temporaer
 * unbrauchbaren Nitrado-Verbindung pausiert hat. Manuell deaktivierte Feeds
 * besitzen keinen Auto-Pause-Marker und bleiben unveraendert.
 *
 * Der Aufrufer darf diese Funktion erst ausfuehren, wenn der ADM-Live-Sync die
 * aktuelle Quelle erfolgreich und chronologisch vollstaendig aufgeholt hat.
 * Vor der Reaktivierung wird pro Feed ein High-Watermark auf den aktuellsten
 * kanonischen Event gesetzt, damit waehrend der Pause entstandene Historie
 * nicht nachtraeglich als Discord-Nachrichtenflut zugestellt wird.
 */
export async function resumeAutoPausedGameplayFeeds(
  scope: GameplayFeedRecoveryScope,
): Promise<number> {
  const configs = await prisma.gameplayFeedConfig.findMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      isActive: false,
      autoPausedReason: NITRADO_AUTO_PAUSE_REASON,
    },
    select: {
      id: true,
      kind: true,
      playerListIntervalMinutes: true,
    },
  });
  if (configs.length === 0) return 0;

  const now = new Date();
  let resumed = 0;

  for (const feed of configs) {
    const watermark = await recoveryWatermark(scope, feed.kind, now);

    // CAS gegen parallele Dashboard-Aenderungen: Nur ein noch immer explizit
    // auto-pausierter Feed darf von diesem Recovery-Lauf eingeschaltet werden.
    const result = await prisma.gameplayFeedConfig.updateMany({
      where: {
        id: feed.id,
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        isActive: false,
        autoPausedReason: NITRADO_AUTO_PAUSE_REASON,
      },
      data: {
        isActive: true,
        autoPausedReason: null,
        autoPausedAt: null,
        lastErrorMsg: null,
        lastPolledAt: now,
        nextDeliveryAt: now,
        cursorCreatedAt: watermark.createdAt,
        cursorEventId: watermark.id,
        ...(feed.kind === GameplayFeedKind.PLAYER_LIST
          ? {
              lastStateHash: null,
              nextPlayerListPostAt: feed.playerListIntervalMinutes ? now : null,
            }
          : {}),
      },
    });
    resumed += result.count;
  }

  return resumed;
}
