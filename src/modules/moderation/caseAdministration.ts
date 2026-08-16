import { randomUUID } from 'node:crypto';
import { PermissionFlagsBits, type Guild, type PermissionResolvable } from 'discord.js';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { postModLog } from './modLog';

const NOTE_MAX = 500;
const CLAIM_PREFIX = 'pending:';

type ReviewDecision = 'APPROVED' | 'DENIED';

const REVOKE_PERMISSION: Record<string, PermissionResolvable> = {
  KICK: PermissionFlagsBits.KickMembers,
  BAN: PermissionFlagsBits.BanMembers,
  TEMP_BAN: PermissionFlagsBits.BanMembers,
  MUTE: PermissionFlagsBits.ModerateMembers,
  TEMP_MUTE: PermissionFlagsBits.ModerateMembers,
  WARN: PermissionFlagsBits.ModerateMembers,
};

function cleanNote(value: string | undefined, fallback: string): string {
  const source = (value ?? fallback).normalize('NFKC');
  if (/[\r\n\t\u0000-\u001f\u007f]/.test(source)) throw new Error('Notiz enthaelt ungueltige Steuerzeichen.');
  const clean = source.trim().replace(/\s+/g, ' ');
  if (!clean || clean.length > NOTE_MAX) throw new Error(`Notiz muss 1..${NOTE_MAX} Zeichen enthalten.`);
  return clean;
}

async function assertModeratorPermission(
  guild: Guild,
  moderatorDiscordId: string,
  permission: PermissionResolvable,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (guild.ownerId === moderatorDiscordId) return { ok: true };
  const moderator = await guild.members.fetch(moderatorDiscordId).catch(() => null);
  if (!moderator) return { ok: false, message: 'Moderator nicht im Server gefunden.' };
  if (!moderator.permissions.has(permission)) {
    return { ok: false, message: 'Du hast nicht die noetige Berechtigung fuer diese Aktion.' };
  }
  return { ok: true };
}

async function assertHierarchy(
  guild: Guild,
  moderatorDiscordId: string,
  targetDiscordId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const target = await guild.members.fetch(targetDiscordId).catch(() => null);
  if (!target) return { ok: true };
  const moderator = await guild.members.fetch(moderatorDiscordId).catch(() => null);
  if (guild.ownerId !== moderatorDiscordId && moderator && target.roles.highest.position >= moderator.roles.highest.position) {
    return { ok: false, message: 'Ziel-Nutzer hat eine gleich hohe oder hoehere Rolle.' };
  }
  const bot = guild.members.me;
  if (bot && target.roles.highest.position >= bot.roles.highest.position) {
    return { ok: false, message: 'Bot-Rolle ist nicht hoch genug fuer diese Aktion.' };
  }
  return { ok: true };
}

function isUnknownBan(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && Number((error as { code?: unknown }).code) === 10026;
}

async function reverseDiscordSanction(
  guild: Guild,
  action: string,
  targetDiscordId: string,
  reason: string,
): Promise<void> {
  if (action === 'BAN' || action === 'TEMP_BAN') {
    try {
      await guild.members.unban(targetDiscordId, reason);
    } catch (error) {
      // Discord 10026 = Unknown Ban: Sanktion ist bereits effektiv aufgehoben.
      if (!isUnknownBan(error)) throw error;
    }
    return;
  }
  if (action === 'MUTE' || action === 'TEMP_MUTE') {
    const member = await guild.members.fetch(targetDiscordId).catch(() => null);
    if (member?.isCommunicationDisabled()) await member.timeout(null, reason);
  }
}

export interface RevokeCaseResult {
  success: boolean;
  message: string;
  caseNumber?: number;
}

/**
 * Hebt einen aktiven Moderations-Case guild-gescoppt und konkurenzsicher auf.
 *
 * Der Case wird zuerst per updateMany-CAS mit einem eindeutigen pending-Token
 * geclaimt. So kann in mehreren Bot-Instanzen nur ein Reviewer den Discord-
 * Sideeffect ausfuehren. Schlaegt der Sideeffect fehl, wird exakt dieser Claim
 * wieder auf aktiv zurueckgesetzt. Erst nach Erfolg wird revokedBy finalisiert.
 */
export async function revokeModerationCase(args: {
  guild: Guild;
  caseNumber: number;
  moderatorDiscordId: string;
  note?: string;
}): Promise<RevokeCaseResult> {
  const { guild, caseNumber, moderatorDiscordId } = args;
  if (!Number.isSafeInteger(caseNumber) || caseNumber < 1) return { success: false, message: 'Ungueltige Case-Nummer.' };

  const modCase = await prisma.moderationCase.findFirst({
    where: { caseNumber, guildId: guild.id },
    include: { targetUser: true },
  });
  if (!modCase) return { success: false, message: `Case #${caseNumber} wurde auf diesem Server nicht gefunden.` };
  if (!modCase.isActive || modCase.revokedAt) return { success: false, message: `Case #${caseNumber} ist bereits inaktiv.` };

  const permission = REVOKE_PERMISSION[modCase.action] ?? PermissionFlagsBits.ModerateMembers;
  const permissionCheck = await assertModeratorPermission(guild, moderatorDiscordId, permission);
  if (!permissionCheck.ok) return { success: false, message: permissionCheck.message };
  const hierarchyCheck = await assertHierarchy(guild, moderatorDiscordId, modCase.targetUser.discordId);
  if (!hierarchyCheck.ok) return { success: false, message: hierarchyCheck.message };

  const note = cleanNote(args.note, `Case #${caseNumber} manuell aufgehoben`);
  const claimedAt = new Date();
  const claimToken = `${CLAIM_PREFIX}${moderatorDiscordId}:${randomUUID()}`;
  const claim = await prisma.moderationCase.updateMany({
    where: { id: modCase.id, guildId: guild.id, isActive: true, revokedAt: null },
    data: { isActive: false, revokedAt: claimedAt, revokedBy: claimToken },
  });
  if (claim.count !== 1) {
    return { success: false, message: `Case #${caseNumber} wird bereits bearbeitet oder ist nicht mehr aktiv.` };
  }

  try {
    await reverseDiscordSanction(guild, modCase.action, modCase.targetUser.discordId, note);
  } catch (error) {
    const rollback = await prisma.moderationCase.updateMany({
      where: { id: modCase.id, guildId: guild.id, isActive: false, revokedBy: claimToken },
      data: { isActive: true, revokedAt: null, revokedBy: null },
    });
    logger.error(`Ruecknahme von Case #${caseNumber} fehlgeschlagen:`, error);
    logAudit('MODERATION_REVOKE_FAILED', 'MODERATION', {
      guildId: guild.id,
      caseNumber,
      action: modCase.action,
      moderatorDiscordId,
      rollbackSucceeded: rollback.count === 1,
      error: error instanceof Error ? error.message : String(error),
    });
    if (rollback.count !== 1) logger.error(`KRITISCH: Claim-Rollback fuer Case #${caseNumber} fehlgeschlagen.`);
    return { success: false, caseNumber, message: `Case #${caseNumber} konnte nicht sicher aufgehoben werden.` };
  }

  const finalize = await prisma.moderationCase.updateMany({
    where: { id: modCase.id, guildId: guild.id, isActive: false, revokedBy: claimToken },
    data: { revokedBy: moderatorDiscordId },
  });
  if (finalize.count !== 1) {
    logger.error(`KRITISCH: Discord-Sanktion fuer Case #${caseNumber} wurde aufgehoben, DB-Claim aber nicht finalisiert.`);
    logAudit('MODERATION_REVOKE_FINALIZE_FAILED', 'MODERATION', {
      guildId: guild.id, caseNumber, moderatorDiscordId, claimToken,
    });
    return { success: false, caseNumber, message: `Case #${caseNumber} wurde auf Discord aufgehoben, der Audit-Status muss aber geprueft werden.` };
  }

  logAudit('MODERATION_REVOKED', 'MODERATION', {
    guildId: guild.id,
    caseNumber,
    action: modCase.action,
    targetDiscordId: modCase.targetUser.discordId,
    moderatorDiscordId,
    note,
  });
  await postModLog(guild, {
    action: `${modCase.action}_REVOKED`,
    caseNumber,
    targetUserId: modCase.targetUser.discordId,
    targetUsername: modCase.targetUser.username ?? undefined,
    moderatorUserId: moderatorDiscordId,
    reason: note,
  });
  return { success: true, caseNumber, message: `Case #${caseNumber} wurde sicher aufgehoben.` };
}

export async function listPendingAppeals(guildId: string, limit = 25) {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit)));
  return prisma.appeal.findMany({
    where: { status: 'PENDING', case: { guildId } },
    include: {
      user: { select: { discordId: true, username: true } },
      case: { select: { caseNumber: true, action: true, reason: true, isActive: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: safeLimit,
  });
}

export async function reviewAppeal(args: {
  guild: Guild;
  caseNumber: number;
  reviewerDiscordId: string;
  decision: ReviewDecision;
  note?: string;
}): Promise<{ success: boolean; message: string }> {
  const { guild, caseNumber, reviewerDiscordId, decision } = args;
  if (decision !== 'APPROVED' && decision !== 'DENIED') return { success: false, message: 'Ungueltige Appeal-Entscheidung.' };
  const permissionCheck = await assertModeratorPermission(guild, reviewerDiscordId, PermissionFlagsBits.ModerateMembers);
  if (!permissionCheck.ok) return { success: false, message: permissionCheck.message };

  const modCase = await prisma.moderationCase.findFirst({
    where: { caseNumber, guildId: guild.id },
    include: {
      targetUser: { select: { discordId: true, username: true } },
      appeals: { where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' }, take: 2 },
    },
  });
  if (!modCase) return { success: false, message: `Case #${caseNumber} wurde auf diesem Server nicht gefunden.` };
  if (modCase.appeals.length === 0) return { success: false, message: `Case #${caseNumber} hat keinen offenen Appeal.` };
  if (modCase.appeals.length > 1) {
    logger.error(`Mehrere PENDING Appeals fuer Case #${caseNumber} erkannt.`);
    return { success: false, message: 'Mehrere offene Appeals erkannt. Bitte Datenbestand pruefen.' };
  }

  const appeal = modCase.appeals[0];
  const note = cleanNote(args.note, decision === 'APPROVED' ? 'Appeal genehmigt' : 'Appeal abgelehnt');
  const claimToken = `${CLAIM_PREFIX}${reviewerDiscordId}:${randomUUID()}`;
  const claim = await prisma.appeal.updateMany({
    where: { id: appeal.id, status: 'PENDING', reviewedBy: null, reviewedAt: null },
    data: { reviewedBy: claimToken },
  });
  if (claim.count !== 1) return { success: false, message: `Appeal fuer Case #${caseNumber} wird bereits bearbeitet.` };

  if (decision === 'APPROVED' && modCase.isActive) {
    const revoked = await revokeModerationCase({
      guild,
      caseNumber,
      moderatorDiscordId: reviewerDiscordId,
      note: `Appeal genehmigt: ${note}`.slice(0, NOTE_MAX),
    });
    if (!revoked.success) {
      await prisma.appeal.updateMany({
        where: { id: appeal.id, status: 'PENDING', reviewedBy: claimToken },
        data: { reviewedBy: null },
      });
      return { success: false, message: `Appeal konnte nicht genehmigt werden: ${revoked.message}` };
    }
  }

  const reviewedAt = new Date();
  const finalize = await prisma.appeal.updateMany({
    where: { id: appeal.id, status: 'PENDING', reviewedBy: claimToken },
    data: { status: decision, reviewedBy: reviewerDiscordId, reviewNote: note, reviewedAt },
  });
  if (finalize.count !== 1) {
    logger.error(`KRITISCH: Appeal-Review fuer Case #${caseNumber} konnte nach Claim nicht finalisiert werden.`);
    logAudit('APPEAL_REVIEW_FINALIZE_FAILED', 'APPEAL', {
      guildId: guild.id, caseNumber, appealId: appeal.id, reviewerDiscordId, decision,
    });
    return { success: false, message: 'Appeal-Entscheidung konnte nicht finalisiert werden. Audit pruefen.' };
  }

  logAudit('APPEAL_REVIEWED', 'APPEAL', {
    guildId: guild.id,
    caseNumber,
    appealId: appeal.id,
    reviewerDiscordId,
    decision,
    note,
  });
  await postModLog(guild, {
    action: `APPEAL_${decision}`,
    caseNumber,
    targetUserId: modCase.targetUser.discordId,
    targetUsername: modCase.targetUser.username ?? undefined,
    moderatorUserId: reviewerDiscordId,
    reason: note,
  });
  return { success: true, message: `Appeal fuer Case #${caseNumber} wurde ${decision === 'APPROVED' ? 'genehmigt' : 'abgelehnt'}.` };
}
