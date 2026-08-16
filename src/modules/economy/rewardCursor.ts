const CURSOR_EPOCH = new Date(0);

export interface RewardCursorScope {
  guildId: string;
  nitradoConnId: string;
}

export interface RewardCursorPosition {
  timestamp: Date;
  entityId: string;
}

interface RewardCursorRow {
  lastTimestamp: Date;
  lastEntityId: string;
}

export interface RewardCursorClient {
  rewardProcessingCursor: {
    upsert: (args: unknown) => Promise<RewardCursorRow>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
}

/**
 * Liefert einen persistenten, server- und streambezogenen High-Watermark.
 * Ein neuer Stream startet absichtlich bei Epoch 0. Ob ein historisches Event
 * bezahlt werden darf entscheidet weiterhin ausschliesslich der Link-Cutoff;
 * dadurch werden alte Daten zwar idempotent konsumiert, aber nie backpaid.
 */
export async function getRewardCursor(
  client: RewardCursorClient,
  scope: RewardCursorScope,
  stream: string,
): Promise<RewardCursorPosition> {
  const row = await client.rewardProcessingCursor.upsert({
    where: {
      guildId_nitradoConnId_stream: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        stream,
      },
    },
    create: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      stream,
      lastTimestamp: CURSOR_EPOCH,
      lastEntityId: '',
    },
    update: {},
    select: { lastTimestamp: true, lastEntityId: true },
  });
  return { timestamp: row.lastTimestamp, entityId: row.lastEntityId };
}

/**
 * Monotones Advance: ein langsamer paralleler Worker darf einen bereits weiter
 * fortgeschrittenen Cursor niemals zuruecksetzen.
 */
export async function advanceRewardCursor(
  client: RewardCursorClient,
  scope: RewardCursorScope,
  stream: string,
  next: RewardCursorPosition,
): Promise<void> {
  await client.rewardProcessingCursor.updateMany({
    where: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      stream,
      OR: [
        { lastTimestamp: { lt: next.timestamp } },
        { lastTimestamp: next.timestamp, lastEntityId: { lt: next.entityId } },
      ],
    },
    data: {
      lastTimestamp: next.timestamp,
      lastEntityId: next.entityId,
    },
  });
}

export function afterCursorWhere(position: RewardCursorPosition, timestampField: string): Record<string, unknown> {
  return {
    OR: [
      { [timestampField]: { gt: position.timestamp } },
      { [timestampField]: position.timestamp, id: { gt: position.entityId } },
    ],
  };
}
