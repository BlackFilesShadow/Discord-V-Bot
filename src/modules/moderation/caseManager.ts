import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { GuildMember, Guild } from 'discord.js';

/**
 * Case-Manager (Sektion 4):
 * - Kick, Ban, Mute, Warn, Filter, Auto-Mod
 * - Eskalationsstufen, Audit-Log, Case-Management
 * - Appeal-System
 */

/**
 * Erstellt einen Moderationsfall und führt die Aktion aus.
 */
export async function createModerationCase(params: {
  targetDiscordId: string;
  moderatorDiscordId: string;
  action: 'KICK' | 'BAN' | 'TEMP_BAN' | 'MUTE' | 'TEMP_MUTE' | 'WARN';
  reason: string;
  duration?: number; // Minuten
  guild: Guild;
}): Promise<{ success: boolean; caseNumber?: number; message: string }> {
  const { targetDiscordId, moderatorDiscordId, action, reason, duration, guild } = params;

  // Safety-Guards (Sektion 4)
  if (targetDiscordId === moderatorDiscordId) {
    return { success: false, message: '❌ Du kannst dich nicht selbst moderieren.' };
  }
  if (targetDiscordId === guild.client.user?.id) {
    return { success: false, message: '❌ Der Bot kann nicht gegen sich selbst aktionieren.' };
  }

  // Hierarchie-Check: Moderator muss höhere Rolle haben als Target
  const targetMember = await guild.members.fetch(targetDiscordId).catch(() => null);
  const modMember = await guild.members.fetch(moderatorDiscordId).catch(() => null);
  if (targetMember && modMember && guild.ownerId !== moderatorDiscordId) {
    if (targetMember.roles.highest.position >= modMember.roles.highest.position) {
      return { success: false, message: '❌ Ziel-Nutzer hat gleich hohe oder höhere Rolle.' };
    }
  }
  // Bot-Hierarchie-Check
  const botMember = guild.members.me;
  if (targetMember && botMember && action !== 'WARN') {
    if (targetMember.roles.highest.position >= botMember.roles.highest.position) {
      return { success: false, message: '❌ Bot-Rolle ist nicht hoch genug für diese Aktion.' };
    }
  }
  // Target nicht im Server (für KICK/MUTE relevant)
  if (!targetMember && (action === 'KICK' || action === 'MUTE' || action === 'TEMP_MUTE')) {
    return { success: false, message: '❌ Nutzer ist nicht (mehr) auf dem Server.' };
  }

  // User-GUIDs auflösen
  const targetUser = await prisma.user.upsert({
    where: { discordId: targetDiscordId },
    create: { discordId: targetDiscordId, username: 'Unknown' },
    update: {},
  });

  const modUser = await prisma.user.findUnique({
    where: { discordId: moderatorDiscordId },
  });

  if (!modUser) {
    return { success: false, message: 'Moderator nicht in DB gefunden.' };
  }

  // Eskalationsstufe berechnen
  const previousCases = await prisma.moderationCase.count({
    where: { targetUserId: targetUser.id, isActive: true },
  });
  const escalationLevel = Math.min(previousCases, 5);

  // Ablaufzeit berechnen
  let expiresAt: Date | null = null;
  if (duration && (action === 'TEMP_BAN' || action === 'TEMP_MUTE')) {
    expiresAt = new Date(Date.now() + duration * 60 * 1000);
  }

  // Case in DB erstellen
  const modCase = await prisma.moderationCase.create({
    data: {
      targetUserId: targetUser.id,
      moderatorId: modUser.id,
      action,
      reason,
      duration,
      expiresAt,
      escalationLevel,
    },
  });

  // Discord-Aktion ausführen
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
        // Automatische Entbannung wird durch Scheduler gehandelt
        break;

      case 'MUTE':
      case 'TEMP_MUTE':
        if (member) {
          const muteMs = duration ? duration * 60 * 1000 : 28 * 24 * 60 * 60 * 1000; // Max 28 Tage
          await member.timeout(muteMs, reason);
        }
        break;

      case 'WARN':
        // Warnung per DM senden
        try {
          const targetDiscordUser = await guild.client.users.fetch(targetDiscordId);
          await targetDiscordUser.send(
            `⚠️ **Verwarnung** auf **${guild.name}**\n` +
            `**Grund:** ${reason}\n` +
            `**Eskalationsstufe:** ${escalationLevel}\n` +
            `**Case-Nr:** #${modCase.caseNumber}\n\n` +
            `Bei Einspruch: Verwende \`/appeal ${modCase.caseNumber}\``
          );
        } catch { /* DMs deaktiviert */ }
        break;
    }
  } catch (error) {
    logger.error(`Moderationsaktion ${action} fehlgeschlagen:`, error);
    return {
      success: false,
      caseNumber: modCase.caseNumber,
      message: `Case erstellt (#${modCase.caseNumber}), aber Discord-Aktion fehlgeschlagen.`,
    };
  }

  // Audit-Log
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

  return {
    success: true,
    caseNumber: modCase.caseNumber,
    message: `Moderationsaktion ${action} ausgeführt. Case #${modCase.caseNumber} erstellt.`,
  };
}

/**
 * Appeal erstellen (Sektion 4: Appeal-System).
 */
export async function createAppeal(
  caseNumber: number,
  userDiscordId: string,
  reason: string
): Promise<{ success: boolean; message: string }> {
  const modCase = await prisma.moderationCase.findUnique({
    where: { caseNumber },
  });

  if (!modCase) {
    return { success: false, message: `Case #${caseNumber} nicht gefunden.` };
  }

  const user = await prisma.user.findUnique({
    where: { discordId: userDiscordId },
  });

  if (!user) {
    return { success: false, message: 'User nicht registriert.' };
  }

  // Prüfe ob User der Betroffene ist
  if (modCase.targetUserId !== user.id) {
    return { success: false, message: 'Du kannst nur eigene Cases anfechten.' };
  }

  // Prüfe ob bereits ein Appeal existiert
  const existingAppeal = await prisma.appeal.findFirst({
    where: { caseId: modCase.id, userId: user.id, status: 'PENDING' },
  });

  if (existingAppeal) {
    return { success: false, message: 'Du hast bereits einen offenen Appeal für diesen Case.' };
  }

  await prisma.appeal.create({
    data: {
      caseId: modCase.id,
      userId: user.id,
      reason,
    },
  });

  logAudit('APPEAL_CREATED', 'APPEAL', {
    caseNumber,
    userId: user.id,
    reason,
  });

  return { success: true, message: `Appeal für Case #${caseNumber} eingereicht. Ein Admin wird sich melden.` };
}

/**
 * Case-Lookup: Details zu einem Case abrufen.
 */
export async function getCaseDetails(caseNumber: number) {
  return prisma.moderationCase.findUnique({
    where: { caseNumber },
    include: {
      targetUser: { select: { discordId: true, username: true } },
      moderator: { select: { discordId: true, username: true } },
      appeals: true,
    },
  });
}

/**
 * Cases für einen User abrufen.
 */
export async function getUserCases(discordId: string) {
  const user = await prisma.user.findUnique({ where: { discordId } });
  if (!user) return [];

  return prisma.moderationCase.findMany({
    where: { targetUserId: user.id },
    include: {
      moderator: { select: { username: true } },
      appeals: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Abgelaufene Temp-Bans/Mutes aufheben (Scheduler).
 */
export async function processExpiredCases(guild: Guild): Promise<number> {
  const expiredCases = await prisma.moderationCase.findMany({
    where: {
      isActive: true,
      expiresAt: { lte: new Date() },
      action: { in: ['TEMP_BAN', 'TEMP_MUTE'] },
    },
    include: {
      targetUser: true,
    },
  });

  let processed = 0;
  for (const modCase of expiredCases) {
    try {
      if (modCase.action === 'TEMP_BAN') {
        await guild.members.unban(modCase.targetUser.discordId, 'Temporärer Ban abgelaufen');
      } else if (modCase.action === 'TEMP_MUTE') {
        const member = await guild.members.fetch(modCase.targetUser.discordId).catch(() => null);
        if (member) {
          await member.timeout(null, 'Temporärer Mute abgelaufen');
        }
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
      });
    } catch (error) {
      logger.error(`Fehler beim Aufheben von Case #${modCase.caseNumber}:`, error);
    }
  }

  return processed;
}
