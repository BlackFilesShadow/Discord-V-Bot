import prisma from '../../database/prisma';
import { leaveCleanupJobKey } from './leaveCleanupSaga';

export type LeaveRejoinFinalizationResult = {
  rejoined: boolean;
  profile: 'NONE' | 'DELETED' | 'RESET';
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
 *   frische LevelData-Baseline; ohne Rejoin wird das letzte Member-Profil nach
 *   dem bereits versendeten Goodbye entfernt.
 *
 * Die Request-createdAt ist die Lifecycle-Grenze: Nur ein aktives Profil mit
 * joinedAt > createdAt kann ein Rejoin NACH diesem Leave sein. Dadurch wird ein
 * noch nicht als left markiertes Altprofil nicht versehentlich als Rejoin
 * interpretiert.
 */
export async function finalizeLeaveRejoinState(
  requestId: string,
  guildId: string,
  discordId: string,
): Promise<LeaveRejoinFinalizationResult> {
  const expectedJobKey = leaveCleanupJobKey(guildId, discordId);

  return prisma.$transaction(async tx => {
    const request = await tx.dataDeletionRequest.findFirst({
      where: {
        id: requestId,
        userId: expectedJobKey,
        discordId,
        requestType: 'PARTIAL_DELETION',
        status: 'IN_PROGRESS',
      },
      select: { createdAt: true },
    });
    if (!request) {
      throw new Error('Leave-Rejoin-Finalizer: aktiver Request/Scope nicht mehr gueltig.');
    }

    const profile = await tx.guildMemberProfile.findUnique({
      where: { guildId_discordId: { guildId, discordId } },
      select: {
        isLeft: true,
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
      // Zweiter Freshness-Cutoff direkt vor COMPLETE. Das faengt auch Writes ab,
      // die zwischen dem normalen GUILD_DATA-Schritt und diesem Finalizer noch
      // eingetroffen sind, solange keine neue Mitgliedschaft nachgewiesen ist.
      if (user) {
        await tx.xpRecord.deleteMany({ where: { userId: user.id, guildId } });
        await tx.levelData.deleteMany({ where: { userId: user.id, guildId } });
      }
      const deletedProfile = await tx.guildMemberProfile.deleteMany({
        where: { guildId, discordId },
      });
      return {
        rejoined: false,
        profile: deletedProfile.count > 0 ? 'DELETED' : 'NONE',
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
