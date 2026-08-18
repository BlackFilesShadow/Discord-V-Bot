import prisma from '../../database/prisma';
import {
  leaveCleanupJobKey,
  readLeaveCleanupDetails,
  type LeaveCleanupRequestLike,
} from './leaveCleanupSaga';

export type LeaveRejoinFinalizationResult = {
  rejoined: boolean;
  profile: 'NONE' | 'RESET';
  levelBaseline: boolean;
};

/**
 * Finaler Rejoin-/Fresh-State-Guard fuer einen noch aktiv geclaimten Leave-Job.
 *
 * Warum dieser Schritt NACH GUILD_DATA und VOR COMPLETE liegt:
 * - Ein Rejoin kann eintreffen, waehrend der alte Leave-Cleanup noch arbeitet.
 * - guildMemberAdd setzt das Recognition-Profil auf den neuen joinedAt-Zeitpunkt.
 * - Alte Level-/XP-Daten duerfen nicht in die neue Mitgliedschaft hineinragen.
 * - Ein echter Rejoin bekommt nach dem destruktiven Cutoff wieder exakt eine
 *   frische LevelData-Baseline.
 *
 * Leave-1F/#104-Invariante: Der Finalizer darf nur unter exakt dem Claim-Snapshot
 * mutieren, den der aufrufende Worker wirklich besitzt. Moderne Claims werden
 * deshalb mit claimToken UND dem durch jeden Checkpoint erneuerten claimedAt
 * gefenced. Ein alter Snapshot mit demselben Token, aber alter Lease, verliert.
 * Legacy-Claims ohne Token bleiben ueber claimedAt kompatibel. Die Claim-Zeile
 * wird in derselben Transaktion FOR UPDATE gesperrt, bevor Player-State mutiert.
 *
 * Das GuildMemberProfile wird bewusst NICHT geloescht: Der Worker kann parallel
 * zum noch laufenden Goodbye-Gateway-Event arbeiten. Die letzte bekannte
 * Identitaet muss fuer Goodbye sicher verfuegbar bleiben. Lifecycle-
 * Normalisierung wird per CAS auf den exakt gelesenen Profilzustand geschrieben;
 * ein parallel eintreffender echter Rejoin wird niemals ueberschrieben.
 *
 * Die Request-createdAt ist die Lifecycle-Grenze: Nur ein aktives Profil mit
 * joinedAt > createdAt kann ein Rejoin NACH diesem Leave sein. Dadurch wird ein
 * noch nicht als left markiertes Altprofil nicht versehentlich als Rejoin
 * interpretiert.
 */
export async function finalizeLeaveRejoinState(
  claimedRequest: LeaveCleanupRequestLike,
  guildId: string,
  discordId: string,
): Promise<LeaveRejoinFinalizationResult> {
  const expectedJobKey = leaveCleanupJobKey(guildId, discordId);
  const expectedDetails = readLeaveCleanupDetails(claimedRequest.details);
  if (
    !expectedDetails
    || expectedDetails.guildId !== guildId
    || claimedRequest.status !== 'IN_PROGRESS'
    || claimedRequest.userId !== expectedJobKey
    || claimedRequest.discordId !== discordId
  ) {
    throw new Error('Leave-Rejoin-Finalizer: geclaimter Request/Scope ist ungueltig.');
  }

  const claimedAt = expectedDetails.claimedAt;
  if (!claimedAt) {
    throw new Error('Leave-Rejoin-Finalizer: Claim-Lease fehlt.');
  }
  const claimToken = expectedDetails.claimToken ?? null;

  return prisma.$transaction(async tx => {
    // FOR UPDATE serialisiert den Finalizer mit stale recovery/reclaim. Moderne
    // Claims muessen sowohl denselben Token als auch exakt dieselbe Lease tragen.
    // Dadurch invalidiert die #104-Checkpoint-Erneuerung jeden alten Snapshot.
    const activeClaims = claimToken
      ? await tx.$queryRawUnsafe<Array<{ createdAt: Date }>>(
          `SELECT "createdAt"
             FROM "DataDeletionRequest"
            WHERE "id"=$1
              AND "userId"=$2
              AND "discordId"=$3
              AND "requestType"='PARTIAL_DELETION'
              AND "status"='IN_PROGRESS'
              AND jsonb_extract_path_text("details", 'claimToken')=$4
              AND jsonb_extract_path_text("details", 'claimedAt')=$5
            FOR UPDATE`,
          claimedRequest.id,
          expectedJobKey,
          discordId,
          claimToken,
          claimedAt,
        )
      : await tx.$queryRawUnsafe<Array<{ createdAt: Date }>>(
          `SELECT "createdAt"
             FROM "DataDeletionRequest"
            WHERE "id"=$1
              AND "userId"=$2
              AND "discordId"=$3
              AND "requestType"='PARTIAL_DELETION'
              AND "status"='IN_PROGRESS'
              AND jsonb_extract_path_text("details", 'claimedAt')=$4
            FOR UPDATE`,
          claimedRequest.id,
          expectedJobKey,
          discordId,
          claimedAt,
        );

    const request = activeClaims[0];
    if (!request) {
      throw new Error('Leave-Rejoin-Finalizer: aktiver Claim/Lease-Snapshot nicht mehr gueltig.');
    }

    const profile = await tx.guildMemberProfile.findUnique({
      where: { guildId_discordId: { guildId, discordId } },
      select: {
        isLeft: true,
        leftAt: true,
        joinedAt: true,
      },
    });

    const user = await tx.user.findUnique({
      where: { discordId },
      select: { id: true },
    });

    const rejoined = !!profile
      && profile.isLeft === false
      && !!profile.joinedAt
      && profile.joinedAt.getTime() > request.createdAt.getTime();

    if (!rejoined) {
      // Zweiter Freshness-Cutoff direkt vor COMPLETE. XP-Schreibpfade sind
      // waehrend eines offenen Cleanup-Barriers gesperrt; diese Deletes raeumen
      // zusaetzlich spaete, bereits gestartete Writes aus der alten Epoche auf.
      if (user) {
        await tx.xpRecord.deleteMany({ where: { userId: user.id, guildId } });
        await tx.levelData.deleteMany({ where: { userId: user.id, guildId } });
      }

      let profileState: 'NONE' | 'RESET' = 'NONE';
      if (profile) {
        // CAS auf den exakt gelesenen Lifecycle-Zustand. Wenn guildMemberAdd oder
        // ein anderer echter Member-Sync zwischen Read und Write joinedAt/isLeft/
        // leftAt aendert, darf dieser alte Snapshot den Rejoin nicht wieder auf
        // LEFT setzen. Retry liest danach den neuen Zustand und erkennt Rejoin.
        const resetProfile = await tx.guildMemberProfile.updateMany({
          where: {
            guildId,
            discordId,
            isLeft: profile.isLeft,
            joinedAt: profile.joinedAt,
            leftAt: profile.leftAt,
          },
          data: {
            messageCount: 0,
            isLeft: true,
            leftAt: profile.leftAt ?? request.createdAt,
          },
        });
        if (resetProfile.count !== 1) {
          throw new Error('Leave-Rejoin-Finalizer: Profil-CAS verloren.');
        }
        profileState = 'RESET';
      }

      return {
        rejoined: false,
        profile: profileState,
        levelBaseline: false,
      };
    }

    if (!user) {
      throw new Error('Leave-Rejoin-Finalizer: aktiver Rejoin ohne User-Stammsatz.');
    }

    // CAS gegen einen erneuten Leave waehrend der Finalisierung. Wenn das Profil
    // inzwischen wieder isLeft=true ist, darf keine frische Baseline entstehen;
    // der Worker retried GUILD_DATA und bewertet den neuesten Zustand erneut.
    const resetProfile = await tx.guildMemberProfile.updateMany({
      where: {
        guildId,
        discordId,
        isLeft: false,
        joinedAt: { gt: request.createdAt },
      },
      data: {
        messageCount: 0,
        leftAt: null,
      },
    });
    if (resetProfile.count !== 1) {
      throw new Error('Leave-Rejoin-Finalizer: Rejoin-Profil-CAS verloren.');
    }

    // GUILD_DATA hat die alte Level-/XP-Epoche bereits entfernt. Falls nach
    // diesem Cutoff schon legitime neue Rejoin-XP geschrieben wurden, bewahrt
    // update:{} diese. Andernfalls entsteht die kanonische 0-XP-Baseline.
    await tx.levelData.upsert({
      where: { userId_guildId: { userId: user.id, guildId } },
      create: { userId: user.id, guildId },
      update: {},
    });

    return {
      rejoined: true,
      profile: 'RESET',
      levelBaseline: true,
    };
  });
}
