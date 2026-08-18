import prisma from '../../database/prisma';
import {
  leaveCleanupJobKey,
  readLeaveCleanupDetails,
  type LeaveCleanupRequestLike,
} from './leaveCleanupSaga';

/**
 * Erneuert die Lease eines exakt geclaimten Leave-Requests, ohne Step/Attempt/
 * sonstige Saga-Metadaten zu veraendern.
 *
 * Moderne Claims werden auf claimToken + dem ALTEN claimedAt gefenced. Damit
 * kann ein alter In-Memory-Snapshot nach einem Heartbeat oder Reclaim keine
 * Lease mehr verlaengern. Legacy-Claims ohne Token bleiben bis zum naechsten
 * Reclaim ueber claimedAt kompatibel.
 */
export async function renewLeaveCleanupClaimLease(
  claimedRequest: LeaveCleanupRequestLike,
  guildId: string,
  discordId: string,
  now: Date = new Date(),
): Promise<LeaveCleanupRequestLike> {
  const details = readLeaveCleanupDetails(claimedRequest.details);
  const expectedJobKey = leaveCleanupJobKey(guildId, discordId);
  if (
    !details
    || details.guildId !== guildId
    || claimedRequest.status !== 'IN_PROGRESS'
    || claimedRequest.userId !== expectedJobKey
    || claimedRequest.discordId !== discordId
  ) {
    throw new Error('Leave-Cleanup Lease: geclaimter Request/Scope ist ungueltig.');
  }
  if (!details.claimedAt) {
    throw new Error('Leave-Cleanup Lease: claimedAt fehlt.');
  }

  const oldClaimedAt = details.claimedAt;
  const oldMs = Date.parse(oldClaimedAt);
  if (!Number.isFinite(oldMs)) {
    throw new Error('Leave-Cleanup Lease: claimedAt ist ungueltig.');
  }
  // Monotonie auch dann erzwingen, wenn Test/Clock denselben Millisekundenwert
  // liefert. Recovery darf nie eine scheinbar unveraenderte Lease sehen.
  const nextMs = Math.max(now.getTime(), oldMs + 1);
  const nextClaimedAt = new Date(nextMs).toISOString();

  const rows = details.claimToken
    ? await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "DataDeletionRequest"
            SET "details" = jsonb_set("details", '{claimedAt}', to_jsonb($6::text), true),
                "updatedAt" = $6::timestamptz
          WHERE "id"=$1
            AND "userId"=$2
            AND "discordId"=$3
            AND "requestType"='PARTIAL_DELETION'
            AND "status"='IN_PROGRESS'
            AND jsonb_extract_path_text("details", 'claimToken')=$4
            AND jsonb_extract_path_text("details", 'claimedAt')=$5
        RETURNING "id"`,
        claimedRequest.id,
        expectedJobKey,
        discordId,
        details.claimToken,
        oldClaimedAt,
        nextClaimedAt,
      )
    : await prisma.$queryRawUnsafe<Array<{ id: string }>>(
        `UPDATE "DataDeletionRequest"
            SET "details" = jsonb_set("details", '{claimedAt}', to_jsonb($5::text), true),
                "updatedAt" = $5::timestamptz
          WHERE "id"=$1
            AND "userId"=$2
            AND "discordId"=$3
            AND "requestType"='PARTIAL_DELETION'
            AND "status"='IN_PROGRESS'
            AND jsonb_extract_path_text("details", 'claimedAt')=$4
        RETURNING "id"`,
        claimedRequest.id,
        expectedJobKey,
        discordId,
        oldClaimedAt,
        nextClaimedAt,
      );

  if (rows.length !== 1) {
    throw new Error('Leave-Cleanup Lease-CAS verloren.');
  }

  return {
    ...claimedRequest,
    details: {
      ...details,
      claimedAt: nextClaimedAt,
    },
  };
}
