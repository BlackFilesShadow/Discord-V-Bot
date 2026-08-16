import { randomUUID } from 'node:crypto';
import type { Guild } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { postModLog } from './modLog';

const SYSTEM_CLAIM_PREFIX = 'pending:system-expiry:';

/**
 * Race-sicherer Ersatz fuer den Legacy-Expiry-Pfad.
 * Jeder abgelaufene TEMP_BAN/TEMP_MUTE wird vor dem Discord-Sideeffect per CAS
 * geclaimt. Damit kann ein manueller Revoke denselben Case nicht parallel
 * bearbeiten und umgekehrt.
 */
export async function processExpiredCasesSafely(guild: Guild): Promise<number> {
  const expiredCases = await prisma.moderationCase.findMany({
    where: {
      isActive: true,
      guildId: guild.id,
      expiresAt: { lte: new Date() },
      action: { in: ['TEMP_BAN', 'TEMP_MUTE'] },
    },
    include: { targetUser: true },
    orderBy: { expiresAt: 'asc' },
    take: 100,
  });

  let processed = 0;
  for (const modCase of expiredCases) {
    const claimToken = `${SYSTEM_CLAIM_PREFIX}${randomUUID()}`;
    const claimedAt = new Date();
    const claim = await prisma.moderationCase.updateMany({
      where: { id: modCase.id, guildId: guild.id, isActive: true, revokedAt: null },
      data: { isActive: false, revokedAt: claimedAt, revokedBy: claimToken },
    });
    if (claim.count !== 1) continue;

    try {
      if (modCase.action === 'TEMP_BAN') {
        try {
          await guild.members.unban(modCase.targetUser.discordId, 'Temporaerer Ban abgelaufen');
        } catch (error) {
          const unknownBan = typeof error === 'object' && error !== null && 'code' in error
            && Number((error as { code?: unknown }).code) === 10026;
          if (!unknownBan) throw error;
        }
      } else {
        const member = await guild.members.fetch(modCase.targetUser.discordId).catch(() => null);
        if (member?.isCommunicationDisabled()) await member.timeout(null, 'Temporaerer Mute abgelaufen');
      }

      const finalize = await prisma.moderationCase.updateMany({
        where: { id: modCase.id, guildId: guild.id, isActive: false, revokedBy: claimToken },
        data: { revokedBy: 'system' },
      });
      if (finalize.count !== 1) {
        logger.error(`KRITISCH: Expiry-Claim fuer Case #${modCase.caseNumber} konnte nicht finalisiert werden.`);
        logAudit('MODERATION_EXPIRE_FINALIZE_FAILED', 'MODERATION', {
          guildId: guild.id, caseNumber: modCase.caseNumber, claimToken,
        });
        continue;
      }

      processed++;
      logAudit('MODERATION_EXPIRED', 'MODERATION', {
        caseNumber: modCase.caseNumber,
        action: modCase.action,
        targetUserId: modCase.targetUserId,
        guildId: guild.id,
      });
      await postModLog(guild, {
        action: `${modCase.action}_EXPIRED`,
        caseNumber: modCase.caseNumber,
        targetUserId: modCase.targetUser.discordId,
        targetUsername: modCase.targetUser.username ?? undefined,
        reason: 'Temporaere Mod-Aktion automatisch abgelaufen.',
      });
    } catch (error) {
      const rollback = await prisma.moderationCase.updateMany({
        where: { id: modCase.id, guildId: guild.id, isActive: false, revokedBy: claimToken },
        data: { isActive: true, revokedAt: null, revokedBy: null },
      });
      logger.error(`Fehler beim Aufheben von Case #${modCase.caseNumber}:`, error);
      logAudit('MODERATION_EXPIRE_FAILED', 'MODERATION', {
        guildId: guild.id,
        caseNumber: modCase.caseNumber,
        action: modCase.action,
        rollbackSucceeded: rollback.count === 1,
        error: error instanceof Error ? error.message : String(error),
      });
      if (rollback.count !== 1) logger.error(`KRITISCH: Expiry-Claim-Rollback fuer Case #${modCase.caseNumber} fehlgeschlagen.`);
    }
  }

  return processed;
}
