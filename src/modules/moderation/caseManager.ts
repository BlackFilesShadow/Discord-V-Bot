import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { Guild, PermissionFlagsBits, type PermissionResolvable } from 'discord.js';
import { postModLog } from './modLog';

/** Defense-in-depth: minimale Discord-Permission pro Moderationsaktion. */
const REQUIRED_PERMISSION: Record<string, PermissionResolvable> = {
  KICK: PermissionFlagsBits.KickMembers,
  BAN: PermissionFlagsBits.BanMembers,
  TEMP_BAN: PermissionFlagsBits.BanMembers,
  MUTE: PermissionFlagsBits.ModerateMembers,
  TEMP_MUTE: PermissionFlagsBits.ModerateMembers,
  WARN: PermissionFlagsBits.ModerateMembers,
};

/**
 * Erstellt einen Moderationsfall und fuehrt die Discord-Aktion aus.
 *
 * Wichtige Invarianten:
 * - Hierarchie + Permission werden serverseitig erneut geprueft.
 * - Eskalation ist strikt auf die Origin-Guild begrenzt.
 * - Ein fehlgeschlagener Discord-Sideeffect bleibt als Audit-Historie erhalten,
 *   wird aber sofort `isActive=false`, damit Scheduler/Appeals ihn niemals als
 *   noch aktive Sanktion behandeln.
 */
export async function createModerationCase(params: {
  targetDiscordId: string;
  moderatorDiscordId: string;
  action: 'KICK' | 'BAN' | 'TEMP_BAN' | 'MUTE' | 'TEMP_MUTE' | 'WARN';
  reason: string;
  duration?: number;
  guild: Guild;
}): Promise<{ success: boolean; caseNumber?: number; message: string }> {
  const { targetDiscordId, moderatorDiscordId, action, reason, duration, guild } = params;

  if (targetDiscordId === moderatorDiscordId) {
    return { success: false, message: 'Du kannst dich nicht selbst moderieren.' };
  }
  if (targetDiscordId === guild.client.user?.id) {
    return { success: false, message: 'Der Bot kann nicht gegen sich selbst aktionieren.' };
  }

  const targetMember = await guild.members.fetch(targetDiscordId).catch(() => null);
  const modMember = await guild.members.fetch(moderatorDiscordId).catch(() => null);

  const requiredPerm = REQUIRED_PERMISSION[action];
  if (requiredPerm && guild.ownerId !== moderatorDiscordId) {
    if (!modMember) {
      return { success: false, message: 'Moderator nicht im Server gefunden.' };
    }
    if (!modMember.permissions.has(requiredPerm)) {
      logger.warn(
        `Backend-Perm-Check abgelehnt: ${moderatorDiscordId} ohne ${String(requiredPerm)} fuer ${action} in ${guild.id}`,
      );
      return { success: false, message: 'Du hast nicht die noetige Berechtigung fuer diese Aktion.' };
    }
  }

  if (targetMember && modMember && guild.ownerId !== moderatorDiscordId) {
    if (targetMember.roles.highest.position >= modMember.roles.highest.position) {
      return { success: false, message: 'Ziel-Nutzer hat eine gleich hohe oder hoehere Rolle.' };
    }
  }

  const botMember = guild.members.me;
  if (targetMember && botMember && action !== 'WARN') {
    if (targetMember.roles.highest.position >= botMember.roles.highest.position) {
      return { success: false, message: 'Bot-Rolle ist nicht hoch genug fuer diese Aktion.' };
    }
  }

  if (!targetMember && (action === 'KICK' || action === 'MUTE' || action === 'TEMP_MUTE')) {
    return { success: false, message: 'Nutzer ist nicht mehr auf dem Server.' };
  }

  // Moderationscommands duerfen nicht davon abhaengen, dass ein separater
  // Member-Sync den Moderator bereits in User angelegt hat.
  const targetDiscordUser = targetMember?.user
    ?? await guild.client.users.fetch(targetDiscordId).catch(() => null);
  const targetUser = await prisma.user.upsert({
    where: { discordId: targetDiscordId },
    create: { discordId: targetDiscordId, username: targetDiscordUser?.username ?? 'Unknown' },
    update: targetDiscordUser?.username ? { username: targetDiscordUser.username } : {},
  });

  const moderatorUsername = modMember?.user.username
    ?? (await guild.client.users.fetch(moderatorDiscordId).catch(() => null))?.username
    ?? 'Unknown';
  const modUser = await prisma.user.upsert({
    where: { discordId: moderatorDiscordId },
    create: { discordId: moderatorDiscordId, username: moderatorUsername },
    update: moderatorUsername !== 'Unknown' ? { username: moderatorUsername } : {},
  });

  // Ausschliesslich aktive Cases derselben Guild beeinflussen die Eskalation.
  const previousCases = await prisma.moderationCase.count({
    where: { guildId: guild.id, targetUserId: targetUser.id, isActive: true },
  });
  const escalationLevel = Math.min(previousCases, 5);

  let expiresAt: Date | null = null;
  if (duration && (action === 'TEMP_BAN' || action === 'TEMP_MUTE')) {
    expiresAt = new Date(Date.now() + duration * 60 * 1000);
  }

  const modCase = await prisma.moderationCase.create({
    data: {
      guildId: guild.id,
      targetUserId: targetUser.id,
      moderatorId: modUser.id,
      action,
      reason,
      duration,
      expiresAt,
      escalationLevel,
    },
  });

  try {
    const member = targetMember;
    switch (action) {
      case 'KICK':
        if (member) await member.kick(reason);
        break;
      case 'BAN':
        await guild.members.ban(targetDiscordId, { reason, deleteMessageSeconds: 604800 });
        break;
      case 'TEMP_BAN':
        await guild.members.ban(targetDiscordId, { reason });
        break;
      case 'MUTE':
      case 'TEMP_MUTE':
        if (member) {
          const muteMs = duration ? duration * 60 * 1000 : 28 * 24 * 60 * 60 * 1000;
          await member.timeout(muteMs, reason);
        }
        break;
      case 'WARN':
        try {
          const target = targetDiscordUser ?? await guild.client.users.fetch(targetDiscordId);
          await target.send(
            `⚠️ **Verwarnung** auf **${guild.name}**\n` +
            `**Grund:** ${reason}\n` +
            `**Eskalationsstufe:** ${escalationLevel}\n` +
            `**Case-Nr:** #${modCase.caseNumber}\n\n` +
            `Bei Einspruch: Verwende \`/appeal case-id:${modCase.caseNumber}\`.`,
          );
        } catch { /* DMs deaktiviert: Warn-Case selbst bleibt gueltig. */ }
        break;
    }
  } catch (error) {
    logger.error(`Moderationsaktion ${action} fehlgeschlagen:`, error);
    const failedAt = new Date();
    await prisma.moderationCase.update({
      where: { id: modCase.id },
      data: {
        isActive: false,
        revokedAt: failedAt,
        revokedBy: 'system:discord_action_failed',
      },
    }).catch(updateError => {
      logger.error(`Fehlgeschlagenen Moderations-Case #${modCase.caseNumber} konnte nicht deaktiviert werden:`, updateError);
    });
    logAudit('MODERATION_ACTION_FAILED', 'MODERATION', {
      caseNumber: modCase.caseNumber,
      action,
      targetUserId: targetUser.id,
      moderatorId: modUser.id,
      guildId: guild.id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      success: false,
      caseNumber: modCase.caseNumber,
      message: `Case #${modCase.caseNumber} wurde als fehlgeschlagener Versuch protokolliert; die Discord-Aktion wurde nicht aktiv.`,
    };
  }

  logAudit('MODERATION_ACTION', 'MODERATION', {
    caseNumber: modCase.caseNumber,
    action,
    targetUserId: targetUser.id,
    moderatorId: modUser.id,
    reason,
    duration,
    escalationLevel,
    guildId: guild.id,
  });

  await postModLog(guild, {
    action,
    caseNumber: modCase.caseNumber,
    targetUserId: targetDiscordId,
    targetUsername: targetMember?.user.username ?? targetUser.username ?? undefined,
    moderatorUserId: moderatorDiscordId,
    moderatorUsername: modMember?.user.username ?? modUser.username ?? undefined,
    reason,
    durationMinutes: duration,
    escalationLevel,
  });

  return {
    success: true,
    caseNumber: modCase.caseNumber,
    message: `Moderationsaktion ${action} ausgefuehrt. Case #${modCase.caseNumber} erstellt.`,
  };
}

/**
 * Appeal erstellen. Wenn expectedGuildId gesetzt ist, muss der Case aus genau
 * dieser Guild stammen (Cross-Guild-Schutz).
 */
export async function createAppeal(
  caseNumber: number,
  userDiscordId: string,
  reason: string,
  expectedGuildId?: string,
): Promise<{ success: boolean; message: string }> {
  const modCase = await prisma.moderationCase.findUnique({
    where: { caseNumber },
  });

  if (!modCase) return { success: false, message: `Case #${caseNumber} nicht gefunden.` };

  if (expectedGuildId && modCase.guildId && modCase.guildId !== expectedGuildId) {
    return { success: false, message: 'Dieser Case gehoert zu einem anderen Server. Reiche den Appeal dort ein.' };
  }
  if (!modCase.isActive) {
    return { success: false, message: 'Dieser Case ist nicht mehr aktiv und kann nicht angefochten werden.' };
  }

  const user = await prisma.user.findUnique({ where: { discordId: userDiscordId } });
  if (!user) return { success: false, message: 'User nicht registriert.' };
  if (modCase.targetUserId !== user.id) return { success: false, message: 'Du kannst nur eigene Cases anfechten.' };

  const existingAppeal = await prisma.appeal.findFirst({
    where: { caseId: modCase.id, userId: user.id, status: 'PENDING' },
  });
  if (existingAppeal) {
    return { success: false, message: 'Du hast bereits einen offenen Appeal fuer diesen Case.' };
  }

  await prisma.appeal.create({
    data: { caseId: modCase.id, userId: user.id, reason },
  });

  logAudit('APPEAL_CREATED', 'APPEAL', {
    caseNumber,
    userId: user.id,
    guildId: modCase.guildId,
    reason,
  });
  return { success: true, message: `Appeal fuer Case #${caseNumber} eingereicht. Ein Admin wird sich melden.` };
}

export async function getCaseDetails(caseNumber: number, guildId?: string) {
  return prisma.moderationCase.findFirst({
    where: { caseNumber, ...(guildId ? { guildId } : {}) },
    include: {
      targetUser: { select: { discordId: true, username: true } },
      moderator: { select: { discordId: true, username: true } },
      appeals: true,
    },
  });
}

export async function getUserCases(discordId: string, guildId?: string) {
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return [];
  return prisma.moderationCase.findMany({
    where: { targetUserId: user.id, ...(guildId ? { guildId } : {}) },
    include: {
      moderator: { select: { username: true } },
      appeals: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/** Abgelaufene Temp-Bans/Mutes servergescopet aufheben. */
export async function processExpiredCases(guild: Guild): Promise<number> {
  const expiredCases = await prisma.moderationCase.findMany({
    where: {
      isActive: true,
      guildId: guild.id,
      expiresAt: { lte: new Date() },
      action: { in: ['TEMP_BAN', 'TEMP_MUTE'] },
    },
    include: { targetUser: true },
  });

  let processed = 0;
  for (const modCase of expiredCases) {
    try {
      if (modCase.action === 'TEMP_BAN') {
        await guild.members.unban(modCase.targetUser.discordId, 'Temporaerer Ban abgelaufen');
      } else if (modCase.action === 'TEMP_MUTE') {
        const member = await guild.members.fetch(modCase.targetUser.discordId).catch(() => null);
        if (member) await member.timeout(null, 'Temporaerer Mute abgelaufen');
      }

      await prisma.moderationCase.update({
        where: { id: modCase.id },
        data: { isActive: false, revokedAt: new Date(), revokedBy: 'system' },
      });

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
      logger.error(`Fehler beim Aufheben von Case #${modCase.caseNumber}:`, error);
    }
  }

  return processed;
}
