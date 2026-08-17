import type { GuildMember, User as DiscordUser } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

/**
 * Phase 18 / User-1: Per-Guild Member-Profile.
 *
 * Persistiert pro (guildId, discordId) eine kompakte Profil-Zeile, die der
 * AI-Kontext-Builder nutzt, damit der Bot exakt weiss, wer welche Rollen hat,
 * wann jemand beigetreten ist und wann er zuletzt aktiv war.
 *
 * WICHTIG: Diese Daten sind Recognition-/Kontextdaten. Sie duerfen niemals
 * allein fuer Authorization, Permission-Checks oder Rollenfreigaben verwendet
 * werden. Berechtigungen muessen weiterhin aus dem aktuellen Trusted Runtime
 * Context ermittelt werden.
 *
 * Optimierung: messageCreate ruft uns sehr haeufig auf. Wir throttlen Schreibzugriffe
 * pro Member auf max 1x / 60s. Der messageCount-Inkrement passiert dennoch bei jedem
 * Schreibvorgang (also throttled aber nicht verloren), weil wir die Anzahl seit
 * letztem Flush mitzaehlen.
 */

const FLUSH_INTERVAL_MS = 60 * 1000; // max 1 Schreibvorgang pro Member / Minute

interface PendingDelta {
  count: number;
  lastFlushAt: number;
}
const pending = new Map<string, PendingDelta>(); // key = `${guildId}:${discordId}`

function memberKey(guildId: string, discordId: string): string {
  return `${guildId}:${discordId}`;
}

function topRoleNames(member: GuildMember): string[] {
  return member.roles.cache
    .filter((r) => r.name !== '@everyone')
    .sort((a, b) => b.position - a.position)
    .first(8)
    .map((r) => r.name.slice(0, 60));
}

/**
 * Aktualisiert ausschliesslich bereits vorhandene globale Discord-Stammdaten.
 * Ein Rename darf keinen neuen Bot-Account erzeugen und aendert keinerlei
 * Authorization-/Permission-Felder.
 */
export async function syncDiscordUserIdentity(user: Pick<DiscordUser, 'id' | 'username' | 'discriminator'>): Promise<void> {
  try {
    await prisma.user.updateMany({
      where: { discordId: user.id },
      data: {
        username: user.username,
        discriminator: user.discriminator || '',
      },
    });
  } catch (e) {
    logger.warn(`memberAwareness.syncDiscordUserIdentity fehlgeschlagen (${user.id}): ${String(e)}`);
  }
}

/**
 * Entfernt nur noch nicht persistierte Activity-Deltas aus dem Prozessspeicher.
 * Beim Leave duerfen alte Deltas nicht nach einem spaeteren Rejoin in die neue
 * Runtime-Phase hineinflushen.
 */
export function clearPendingMemberActivity(guildId: string, discordId: string): void {
  pending.delete(memberKey(guildId, discordId));
}

/**
 * Throttled-Upsert nach jeder verarbeiteten Nachricht. Best-effort,
 * Fehler werden geloggt aber nicht weitergereicht.
 */
export async function trackMemberActivity(member: GuildMember): Promise<void> {
  const key = memberKey(member.guild.id, member.id);
  const now = Date.now();
  const slot = pending.get(key) ?? { count: 0, lastFlushAt: 0 };
  slot.count += 1;
  pending.set(key, slot);
  if (now - slot.lastFlushAt < FLUSH_INTERVAL_MS) return;
  // Flush.
  const inc = slot.count;
  slot.count = 0;
  slot.lastFlushAt = now;
  try {
    await prisma.guildMemberProfile.upsert({
      where: { guildId_discordId: { guildId: member.guild.id, discordId: member.id } },
      create: {
        guildId: member.guild.id,
        discordId: member.id,
        username: member.user.username,
        nickname: member.nickname ?? null,
        joinedAt: member.joinedAt ?? null,
        topRolesJson: topRoleNames(member) as any,
        isBoosting: !!member.premiumSince,
        boostingSince: member.premiumSince ?? null,
        isPending: !!member.pending,
        timeoutUntil: member.communicationDisabledUntil ?? null,
        messageCount: inc,
        lastSeenAt: new Date(),
        isLeft: false,
        leftAt: null,
      },
      update: {
        username: member.user.username,
        nickname: member.nickname ?? null,
        topRolesJson: topRoleNames(member) as any,
        isBoosting: !!member.premiumSince,
        boostingSince: member.premiumSince ?? null,
        isPending: !!member.pending,
        timeoutUntil: member.communicationDisabledUntil ?? null,
        messageCount: { increment: inc },
        lastSeenAt: new Date(),
        isLeft: false,
        leftAt: null,
      },
    });
  } catch (e) {
    logger.warn(`memberAwareness.trackMemberActivity fehlgeschlagen (${key}): ${String(e)}`);
  }
}

/**
 * Bei guildMemberAdd / guildMemberUpdate / UserUpdate: vollstaendige,
 * exakt guild-gescoppte Aktualisierung ohne Throttle.
 */
export async function syncMemberProfile(member: GuildMember): Promise<void> {
  try {
    await prisma.guildMemberProfile.upsert({
      where: { guildId_discordId: { guildId: member.guild.id, discordId: member.id } },
      create: {
        guildId: member.guild.id,
        discordId: member.id,
        username: member.user.username,
        nickname: member.nickname ?? null,
        joinedAt: member.joinedAt ?? null,
        topRolesJson: topRoleNames(member) as any,
        isBoosting: !!member.premiumSince,
        boostingSince: member.premiumSince ?? null,
        isPending: !!member.pending,
        timeoutUntil: member.communicationDisabledUntil ?? null,
        lastSeenAt: new Date(),
        isLeft: false,
        leftAt: null,
      },
      update: {
        username: member.user.username,
        nickname: member.nickname ?? null,
        joinedAt: member.joinedAt ?? null,
        topRolesJson: topRoleNames(member) as any,
        isBoosting: !!member.premiumSince,
        boostingSince: member.premiumSince ?? null,
        isPending: !!member.pending,
        timeoutUntil: member.communicationDisabledUntil ?? null,
        lastSeenAt: new Date(),
        isLeft: false,
        leftAt: null,
      },
    });
  } catch (e) {
    logger.warn(`memberAwareness.syncMemberProfile fehlgeschlagen: ${String(e)}`);
  }
}

/**
 * Bei guildMemberRemove: als verlassen markieren (nicht loeschen, damit die
 * letzte bekannte Guild-Identitaet fuer Audit/Goodbye erhalten bleibt).
 */
export async function markMemberLeft(guildId: string, discordId: string): Promise<void> {
  clearPendingMemberActivity(guildId, discordId);
  try {
    await prisma.guildMemberProfile.updateMany({
      where: { guildId, discordId, isLeft: false },
      data: { isLeft: true, leftAt: new Date(), lastSeenAt: new Date() },
    });
  } catch (e) {
    logger.warn(`memberAwareness.markMemberLeft fehlgeschlagen: ${String(e)}`);
  }
}

/**
 * Liefert das gespeicherte Profil (oder null). Wird im AI-Context-Builder genutzt.
 */
export async function getMemberProfile(guildId: string, discordId: string) {
  try {
    return await prisma.guildMemberProfile.findUnique({
      where: { guildId_discordId: { guildId, discordId } },
    });
  } catch (e) {
    logger.warn(`memberAwareness.getMemberProfile fehlgeschlagen: ${String(e)}`);
    return null;
  }
}
