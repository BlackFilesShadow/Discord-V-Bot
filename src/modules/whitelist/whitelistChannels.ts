/**
 * Whitelist-Kanal-Integration.
 *
 * Kanaele pro (Guild + Gameserver):
 *   - whitelistChannelId           Info-Kanal mit (genau 1) Whitelist-Erklaerungs-Embed
 *   - whitelistRequestChannelId    Approval-Kanal mit Accept/Deny-Buttons fuer Admins
 *   - whitelistApproveLogChannelId optionaler permanenter Archiv-Kanal fuer Annahmen
 *   - whitelistDenyLogChannelId    optionaler permanenter Archiv-Kanal fuer Ablehnungen
 *
 * Eine Entscheidung entfernt die offene Anfrage aus dem Approval-Kanal, informiert
 * den Antragsteller kurz im Info-Kanal sowie per DM und erzeugt im konfigurierten
 * Annahme-/Ablehnungs-Kanal einen dauerhaften Archiveintrag.
 */

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  type Client, type GuildTextBasedChannel, type Snowflake,
} from 'discord.js';
import prisma from '../../database/prisma';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { logger } from '../../utils/logger';
import { safeEmbedField } from '../../utils/embedSanitize';
import { Colors, statusTitle } from '../../utils/embedDesign';

/** Max-Laenge fuer Whitelist-Reason (Eingabe + Anzeige, einheitlich). */
export const WHITELIST_REASON_MAX = 500;
const DECISION_NOTICE_TTL_MS = 15_000;

let warnedClientMissing = false;
function client(): Client | null {
  const c = tryGetDashboardClient();
  if (!c) {
    if (!warnedClientMissing) {
      warnedClientMissing = true;
      logger.warn('Whitelist: Discord-Client nicht verfuegbar — Discord-seitige Effekte werden uebersprungen, bis Client bereit ist.');
    }
    return null;
  }
  if (warnedClientMissing) {
    warnedClientMissing = false;
    logger.info('Whitelist: Discord-Client wieder verfuegbar.');
  }
  return c;
}

async function fetchTextChannel(guildId: string, channelId: string | null | undefined): Promise<GuildTextBasedChannel | null> {
  if (!channelId) return null;
  const c = client();
  if (!c) return null;
  const guild = c.guilds.cache.get(guildId as Snowflake);
  if (!guild) return null;
  const ch = guild.channels.cache.get(channelId as Snowflake) ?? await guild.channels.fetch(channelId as Snowflake).catch(() => null);
  if (!ch || !ch.isTextBased()) return null;
  return ch as GuildTextBasedChannel;
}

async function resolveDiscordDisplayName(guildId: string, userId: string): Promise<string> {
  const c = client();
  if (!c) return 'Unbekannter Discord-Nutzer';

  const guild = c.guilds.cache.get(guildId as Snowflake);
  const member = guild
    ? guild.members.cache.get(userId as Snowflake) ?? await guild.members.fetch(userId as Snowflake).catch(() => null)
    : null;
  if (member) return safeEmbedField(member.displayName || member.user.globalName || member.user.username, 256);

  const user = await c.users.fetch(userId as Snowflake).catch(() => null);
  return safeEmbedField(user?.globalName || user?.username || 'Unbekannter Discord-Nutzer', 256);
}

function decisionDateParts(decidedAt: Date): { date: string; time: string } {
  const date = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(decidedAt);
  const time = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(decidedAt);
  return { date, time: `${time} Uhr` };
}

/** Loescht best-effort das eine Info-Embed aus einem alten Kanal. */
export async function deleteOldInfoEmbed(guildId: string, channelId: string, messageId: string): Promise<void> {
  const ch = await fetchTextChannel(guildId, channelId);
  if (!ch) return;
  const c = client();
  const msg = await ch.messages.fetch(messageId).catch(() => null);
  if (!msg) return;
  if (c?.user && msg.author.id !== c.user.id) return;
  await msg.delete().catch(() => null);
}

/**
 * Eine entschiedene Anfrage wird aus dem Approval-Kanal entfernt. Historischer
 * Funktionsname bleibt fuer Dashboard-/Runtime-Kompatibilitaet bestehen.
 */
export async function finalizeApprovalEmbed(args: {
  guildId: string; channelId: string; messageId: string;
  approved: boolean; decidedByDiscordId: string;
}): Promise<void> {
  const ch = await fetchTextChannel(args.guildId, args.channelId);
  if (!ch) return;
  const msg = await ch.messages.fetch(args.messageId).catch(() => null);
  if (msg) {
    const c = client();
    if (!c?.user || msg.author.id === c.user.id) await msg.delete().catch(() => null);
  }
  await prisma.whitelistRequest.updateMany({
    where: { messageId: args.messageId, guildId: args.guildId },
    data: { messageId: null },
  }).catch(() => null);
}

/** Postet/aktualisiert das eine Whitelist-Erklaerungs-Embed im Info-Kanal. */
export async function ensureWhitelistInfoEmbed(guildId: string, nitradoConnId: string): Promise<{ posted: boolean; updated: boolean; messageId?: string }> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
  });
  if (!settings?.whitelistChannelId) return { posted: false, updated: false };

  const ch = await fetchTextChannel(guildId, settings.whitelistChannelId);
  if (!ch) return { posted: false, updated: false };

  const embed = new EmbedBuilder()
    .setTitle(statusTitle('INFO', 'Whitelist'))
    .setColor(Colors.Info)
    .setDescription([
      'Du möchtest Zugang zum Server? Hier kannst du deinen Whitelist-Antrag stellen.',
      '',
      '**So funktioniert es:**',
      '1. Nutze `/whitelist-antrag` in diesem Kanal.',
      '2. Trage deinen **exakten Spielernamen** ein (1–64 Zeichen).',
      '3. Sind mehrere aktive Server verbunden, wähle den gewünschten Server über seinen Alias aus. Bei nur einem aktiven Server ist keine Serverauswahl nötig.',
      '',
      'Dein Antrag wird anschließend **automatisch** an das zuständige Server-Team zur Prüfung weitergeleitet.',
      'Nach der Entscheidung wirst du über Annahme oder Ablehnung benachrichtigt.',
      '',
      '**Wichtig:** Der Spielername muss exakt so angegeben werden, wie er im Spiel angezeigt wird. Achte auf Groß-/Kleinschreibung und Sonderzeichen.',
    ].join('\n'))
    .setFooter({ text: 'V-Bot • Whitelist' })
    .setTimestamp(new Date());

  if (settings.whitelistInfoMessageId) {
    const msg = await ch.messages.fetch(settings.whitelistInfoMessageId).catch(() => null);
    if (msg && msg.author.id === client()!.user!.id) {
      await msg.edit({ embeds: [embed] }).catch(() => null);
      return { posted: false, updated: true, messageId: msg.id };
    }
    await prisma.serverSettings.update({
      where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
      data: { whitelistInfoMessageId: null },
    }).catch(() => null);
  }

  const sent = await ch.send({ embeds: [embed] });
  await prisma.serverSettings.update({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
    data: { whitelistInfoMessageId: sent.id },
  });
  return { posted: true, updated: false, messageId: sent.id };
}

/** Postet das Approval-Embed im konfigurierten Request-Kanal. */
export async function postWhitelistApprovalEmbed(args: {
  guildId: string; nitradoConnId: string; requestId: string;
  requesterDiscordId: string; gameId: string;
}): Promise<string | null> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId: args.guildId, nitradoConnId: args.nitradoConnId } },
  });
  if (!settings?.whitelistRequestChannelId) {
    logger.warn(`Whitelist: Kein Request-Channel konfiguriert (guild=${args.guildId} connection=${args.nitradoConnId})`);
    return null;
  }
  const ch = await fetchTextChannel(args.guildId, settings.whitelistRequestChannelId);
  if (!ch) return null;

  const embed = new EmbedBuilder()
    .setTitle(statusTitle('WARNING', 'Neue Whitelist-Anfrage'))
    .setColor(Colors.Warning)
    .addFields(
      { name: 'Antragsteller', value: `<@${args.requesterDiscordId}>`, inline: true },
      { name: 'Beantragter Spielername', value: `\`${args.gameId}\``, inline: true },
    )
    .setFooter({ text: 'V-Bot • Whitelist' })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`wlreq:a:${args.requestId}`)
      .setLabel('Annehmen')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`wlreq:d:${args.requestId}`)
      .setLabel('Ablehnen')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`wlreq:u:${args.requestId}`)
      .setLabel('Universal Whitelist')
      .setEmoji('🌐')
      .setStyle(ButtonStyle.Primary),
  );

  const sent = await ch.send({ embeds: [embed], components: [row] });
  await prisma.whitelistRequest.update({
    where: { id: args.requestId, guildId: args.guildId },
    data: { messageId: sent.id, channelId: ch.id },
  });
  return sent.id;
}

/** Schickt dem User per DM eine Benachrichtigung, dass die Anfrage eingegangen ist. */
export async function notifyRequesterPending(guildId: string, requesterDiscordId: string, gameId: string): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    const user = await c.users.fetch(requesterDiscordId);
    const embed = new EmbedBuilder()
      .setTitle(statusTitle('INFO', 'Whitelist-Anfrage eingegangen'))
      .setColor(Colors.Info)
      .setDescription('Deine Anfrage wurde dem zustaendigen Server-Team weitergeleitet. Bitte warte auf die Entscheidung.')
      .addFields({ name: 'Beantragter Name', value: `\`${gameId}\`` })
      .setFooter({ text: 'V-Bot • Whitelist' })
      .setTimestamp(new Date());
    await user.send({ embeds: [embed] });
  } catch (e) {
    logger.warn(`Whitelist: DM an ${requesterDiscordId} fehlgeschlagen: ${(e as Error).message}`);
  }
}

/** Schickt dem User die Entscheidung per DM. */
export async function notifyRequesterDecision(args: {
  requesterDiscordId: string; gameId: string; approved: boolean; reason?: string; description?: string;
}): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    const user = await c.users.fetch(args.requesterDiscordId);
    const embed = new EmbedBuilder()
      .setTitle(statusTitle(
        args.approved ? 'SUCCESS' : 'ERROR',
        args.approved ? 'Whitelist-Anfrage angenommen' : 'Whitelist-Anfrage abgelehnt',
      ))
      .setColor(args.approved ? Colors.Success : Colors.Error)
      .addFields({ name: 'Beantragter Name', value: `\`${args.gameId}\`` })
      .setFooter({ text: 'V-Bot • Whitelist' })
      .setTimestamp(new Date());
    if (args.reason) embed.addFields({ name: 'Begruendung', value: safeEmbedField(args.reason, WHITELIST_REASON_MAX) });
    if (args.approved) embed.setDescription(args.description ?? 'Du wurdest auf die Whitelist gesetzt. Viel Spass!');
    else embed.setDescription(args.description ?? 'Dein Antrag wurde abgelehnt.');
    await user.send({ embeds: [embed] });
  } catch (e) {
    logger.warn(`Whitelist: Entscheidungs-DM an ${args.requesterDiscordId} fehlgeschlagen: ${(e as Error).message}`);
  }
}

async function postTemporaryDecisionNotice(args: {
  guildId: string;
  channelId: string | null | undefined;
  requesterDiscordId: string;
  gameId: string;
  approved: boolean;
  reason?: string;
  decidedAt: Date;
}): Promise<void> {
  const ch = await fetchTextChannel(args.guildId, args.channelId);
  if (!ch) return;

  const embed = new EmbedBuilder()
    .setTitle(statusTitle(
      args.approved ? 'SUCCESS' : 'ERROR',
      args.approved ? 'Whitelist-Anfrage angenommen' : 'Whitelist-Anfrage abgelehnt',
    ))
    .setColor(args.approved ? Colors.Success : Colors.Error)
    .setDescription(args.approved
      ? 'Deine Whitelist-Anfrage wurde angenommen. Weitere Informationen findest du in deiner DM.'
      : 'Deine Whitelist-Anfrage wurde abgelehnt. Weitere Informationen findest du in deiner DM.')
    .addFields({ name: 'Beantragter Spielername', value: `\`${args.gameId}\`` })
    .setFooter({ text: 'V-Bot • Whitelist • temporäre Information' })
    .setTimestamp(args.decidedAt);
  if (args.reason) embed.addFields({ name: 'Begründung', value: safeEmbedField(args.reason, WHITELIST_REASON_MAX) });

  const sent = await ch.send({
    content: `<@${args.requesterDiscordId}>`,
    embeds: [embed],
    allowedMentions: { users: [args.requesterDiscordId] },
  });
  const timer = setTimeout(() => { void sent.delete().catch(() => null); }, DECISION_NOTICE_TTL_MS);
  timer.unref?.();
}

async function postPermanentDecisionArchive(args: {
  guildId: string;
  channelId: string | null | undefined;
  requesterDiscordId: string;
  gameId: string;
  approved: boolean;
  decidedByDiscordId: string;
  reason?: string;
  decidedAt: Date;
}): Promise<void> {
  const ch = await fetchTextChannel(args.guildId, args.channelId);
  if (!ch) return;

  const [requesterName, adminName] = await Promise.all([
    resolveDiscordDisplayName(args.guildId, args.requesterDiscordId),
    resolveDiscordDisplayName(args.guildId, args.decidedByDiscordId),
  ]);
  const when = decisionDateParts(args.decidedAt);

  const embed = new EmbedBuilder()
    .setTitle(statusTitle(
      args.approved ? 'SUCCESS' : 'ERROR',
      args.approved ? 'Whitelist-Antrag angenommen' : 'Whitelist-Antrag abgelehnt',
    ))
    .setColor(args.approved ? Colors.Success : Colors.Error)
    .addFields(
      { name: 'Discord-Name', value: requesterName, inline: true },
      { name: 'Beantragter Spielername', value: `\`${args.gameId}\``, inline: true },
      { name: args.approved ? 'Genehmigt von' : 'Abgelehnt von', value: adminName, inline: false },
      { name: 'Datum', value: when.date, inline: true },
      { name: 'Uhrzeit', value: when.time, inline: true },
    )
    .setFooter({ text: 'V-Bot • Whitelist • Archiv' })
    .setTimestamp(args.decidedAt);
  if (args.reason) embed.addFields({ name: 'Begründung', value: safeEmbedField(args.reason, WHITELIST_REASON_MAX) });

  await ch.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

/**
 * Gemeinsamer Entscheidungs-Ausgabepfad fuer Dashboard und Discord-Buttons:
 * - kurze, automatisch geloeschte User-Information im konfigurierten Info-Kanal
 * - dauerhafter Archiveintrag im Annahme- bzw. Ablehnungs-Log-Kanal
 */
export async function postDecisionLog(args: {
  guildId: string; nitradoConnId: string; approved: boolean;
  requesterDiscordId: string; gameId: string;
  decidedByDiscordId: string; reason?: string; decidedAt?: Date;
}): Promise<void> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId: args.guildId, nitradoConnId: args.nitradoConnId } },
  });
  if (!settings) return;

  const decidedAt = args.decidedAt ?? new Date();
  const archiveChannelId = args.approved
    ? settings.whitelistApproveLogChannelId
    : settings.whitelistDenyLogChannelId;

  const results = await Promise.allSettled([
    postTemporaryDecisionNotice({
      guildId: args.guildId,
      channelId: settings.whitelistChannelId,
      requesterDiscordId: args.requesterDiscordId,
      gameId: args.gameId,
      approved: args.approved,
      reason: args.reason,
      decidedAt,
    }),
    postPermanentDecisionArchive({
      guildId: args.guildId,
      channelId: archiveChannelId,
      requesterDiscordId: args.requesterDiscordId,
      gameId: args.gameId,
      approved: args.approved,
      decidedByDiscordId: args.decidedByDiscordId,
      reason: args.reason,
      decidedAt,
    }),
  ]);

  for (const result of results) {
    if (result.status === 'rejected') {
      logger.warn(`Whitelist: Entscheidungs-Ausgabe fehlgeschlagen: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
    }
  }
}
