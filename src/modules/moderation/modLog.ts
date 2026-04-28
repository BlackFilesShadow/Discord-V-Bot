import {
  Guild,
  EmbedBuilder,
  TextChannel,
  ChannelType,
  PermissionFlagsBits,
} from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { Colors, vEmbed } from '../../utils/embedDesign';

/**
 * Mod-Log: Persistente, öffentliche Protokollierung von Moderationsaktionen
 * in einem konfigurierbaren Channel pro Guild.
 *
 * Konfiguration liegt in BotConfig unter dem Schlüssel
 *   mod_log_channel:<guildId>   →   { channelId: string }
 *
 * Admins setzen den Channel über `/admin-config setzen` mit genau diesem Key,
 * z.B.:
 *   key   = "mod_log_channel:123456789012345678"
 *   value = "987654321098765432"
 */

const KEY_PREFIX = 'mod_log_channel:';

function configKey(guildId: string): string {
  return `${KEY_PREFIX}${guildId}`;
}

/** Liefert die konfigurierte Mod-Log-Channel-ID für eine Guild — oder null. */
export async function getModLogChannelId(guildId: string): Promise<string | null> {
  const entry = await prisma.botConfig.findUnique({ where: { key: configKey(guildId) } });
  if (!entry) return null;

  // value ist Json — kann String oder { channelId } sein (Toleranz für beide Schreibweisen)
  const v = entry.value as unknown;
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'channelId' in v && typeof (v as { channelId: unknown }).channelId === 'string') {
    return (v as { channelId: string }).channelId;
  }
  return null;
}

/** Setzt (oder ersetzt) die Mod-Log-Channel-ID einer Guild. */
export async function setModLogChannelId(guildId: string, channelId: string, updatedBy?: string): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: configKey(guildId) },
    create: {
      key: configKey(guildId),
      value: channelId,
      category: 'moderation',
      description: `Mod-Log-Channel für Guild ${guildId}`,
      updatedBy,
    },
    update: { value: channelId, updatedBy },
  });
}

/** Entfernt die Mod-Log-Channel-Konfiguration einer Guild. */
export async function clearModLogChannel(guildId: string): Promise<void> {
  await prisma.botConfig.deleteMany({ where: { key: configKey(guildId) } });
}

/**
 * Payload für einen Mod-Log-Eintrag.
 * `action` als Freitext, damit auch Auto-Mod / System-Events („TEMP_MUTE_EXPIRED")
 * geloggt werden können — ohne den ModerationAction-Enum aufblähen zu müssen.
 */
export interface ModLogPayload {
  action: string;                    // 'KICK', 'BAN', 'TEMP_MUTE_EXPIRED', …
  caseNumber?: number;
  targetUserId: string;              // Discord-Snowflake
  targetUsername?: string;
  moderatorUserId?: string;          // Discord-Snowflake (null für System)
  moderatorUsername?: string;
  reason?: string;
  durationMinutes?: number;
  escalationLevel?: number;
}

/** Farb-Mapping je Aktionstyp. */
function colorFor(action: string): number {
  if (action.startsWith('BAN') || action.startsWith('TEMP_BAN')) return Colors.Error;
  if (action === 'KICK')                                          return Colors.Moderation;
  if (action.startsWith('MUTE') || action.startsWith('TEMP_MUTE')) return Colors.Warning;
  if (action === 'WARN')                                           return Colors.Warning;
  if (action.endsWith('_EXPIRED') || action.endsWith('_REVOKED'))  return Colors.Info;
  return Colors.Neutral;
}

/**
 * Postet einen Mod-Log-Eintrag in den konfigurierten Channel der Guild.
 * Failt **niemals** laut — Mod-Log ist Best-Effort und darf die eigentliche
 * Mod-Aktion nicht blockieren.
 */
export async function postModLog(guild: Guild, payload: ModLogPayload): Promise<void> {
  try {
    const channelId = await getModLogChannelId(guild.id);
    if (!channelId) return; // Mod-Log nicht konfiguriert → still aussteigen.

    const channel = guild.channels.cache.get(channelId)
      ?? await guild.channels.fetch(channelId).catch(() => null);

    if (!channel || channel.type !== ChannelType.GuildText) {
      logger.warn(`[modLog] Konfigurierter Channel ${channelId} in Guild ${guild.id} nicht (mehr) verfügbar.`);
      return;
    }

    const text = channel as TextChannel;
    const me = guild.members.me;
    const perms = me ? text.permissionsFor(me) : null;
    if (!perms?.has(PermissionFlagsBits.SendMessages) || !perms.has(PermissionFlagsBits.EmbedLinks)) {
      logger.warn(`[modLog] Keine Send/Embed-Rechte in Channel ${channelId} (Guild ${guild.id}).`);
      return;
    }

    const embed = buildEmbed(payload);
    await text.send({ embeds: [embed] });
  } catch (err) {
    // Best-Effort: bei jedem Fehler nur loggen, niemals werfen.
    logger.error('[modLog] Eintrag fehlgeschlagen:', err);
  }
}

function buildEmbed(p: ModLogPayload): EmbedBuilder {
  const titlePrefix = iconFor(p.action);
  const title = p.caseNumber
    ? `${titlePrefix}  ${p.action} · Case #${p.caseNumber}`
    : `${titlePrefix}  ${p.action}`;

  const target = p.targetUsername
    ? `<@${p.targetUserId}> (\`${p.targetUsername}\`)`
    : `<@${p.targetUserId}>`;

  const moderator = p.moderatorUserId
    ? (p.moderatorUsername ? `<@${p.moderatorUserId}> (\`${p.moderatorUsername}\`)` : `<@${p.moderatorUserId}>`)
    : 'System';

  const fields: { name: string; value: string; inline: boolean }[] = [
    { name: '👤 Nutzer', value: target, inline: true },
    { name: '🛡️ Moderator', value: moderator, inline: true },
  ];

  if (typeof p.durationMinutes === 'number') {
    fields.push({ name: '⏰ Dauer', value: `${p.durationMinutes} Min.`, inline: true });
  }
  if (typeof p.escalationLevel === 'number' && p.escalationLevel > 0) {
    fields.push({ name: '📈 Eskalation', value: `Stufe ${p.escalationLevel}`, inline: true });
  }
  if (p.reason) {
    fields.push({ name: '📝 Grund', value: p.reason.slice(0, 1024), inline: false });
  }

  return vEmbed(colorFor(p.action))
    .setTitle(title)
    .addFields(fields)
    .setTimestamp(new Date());
}

function iconFor(action: string): string {
  if (action.startsWith('BAN') || action.startsWith('TEMP_BAN')) return '🔨';
  if (action === 'KICK')                                          return '🦶';
  if (action.startsWith('MUTE') || action.startsWith('TEMP_MUTE')) return '🔇';
  if (action === 'WARN')                                           return '⚠️';
  if (action.endsWith('_EXPIRED'))                                 return '⌛';
  if (action.endsWith('_REVOKED'))                                 return '↩️';
  return '🛡️';
}
