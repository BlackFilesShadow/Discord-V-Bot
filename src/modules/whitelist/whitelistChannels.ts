/**
 * Whitelist-Kanal-Integration.
 *
 * Vier Kanaele pro (Guild + Slot):
 *   - whitelistChannelId           Info-Kanal mit (genau 1) Command-Erklaerungs-Embed
 *   - whitelistRequestChannelId    Approval-Kanal mit Accept/Deny-Buttons fuer Admins
 *   - whitelistApproveLogChannelId Log fuer ANGENOMMENE Antraege
 *   - whitelistDenyLogChannelId    Log fuer ABGELEHNTE Antraege
 *
 * Strikt: Logs landen NUR im konfigurierten Kanal, nirgendwo anders.
 */

import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  type Client, type GuildTextBasedChannel, type Snowflake,
} from 'discord.js';
import prisma from '../../database/prisma';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { logger } from '../../utils/logger';

function client(): Client | null { return tryGetDashboardClient(); }

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

/**
 * Loescht (best-effort) das EINE Info-Embed aus einem (alten) Kanal.
 * Wird bei Channel-Wechsel/Repost vom Dashboard aufgerufen, damit keine
 * verwaisten Embeds zurueckbleiben.
 */
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
 * Finalisiert das Approval-Embed (Buttons entfernen, Status faerben).
 * Wird vom Dashboard-Decision-Endpoint aufgerufen, damit das Embed im
 * Discord-Annahme-Kanal denselben Endzustand zeigt wie beim Discord-Button.
 */
export async function finalizeApprovalEmbed(args: {
  guildId: string; channelId: string; messageId: string;
  approved: boolean; decidedByDiscordId: string;
}): Promise<void> {
  const ch = await fetchTextChannel(args.guildId, args.channelId);
  if (!ch) return;
  const msg = await ch.messages.fetch(args.messageId).catch(() => null);
  if (!msg) return;
  const c = client();
  if (c?.user && msg.author.id !== c.user.id) return;
  const finalEmbed = EmbedBuilder.from(msg.embeds[0] ?? new EmbedBuilder())
    .setColor(args.approved ? 0x57F287 : 0xED4245)
    .setTitle(args.approved ? 'Whitelist-Antrag angenommen' : 'Whitelist-Antrag abgelehnt')
    .addFields({ name: args.approved ? 'Angenommen von' : 'Abgelehnt von', value: `<@${args.decidedByDiscordId}>` });
  await msg.edit({ embeds: [finalEmbed], components: [] }).catch(() => null);
}

/**
 * Postet/aktualisiert das EINE Command-Erklaerungs-Embed im Info-Kanal.
 * Garantie: pro (Guild+Slot) maximal 1 Embed dieses Bots in diesem Kanal.
 */
export async function ensureWhitelistInfoEmbed(guildId: string, nitradoConnId: string): Promise<{ posted: boolean; updated: boolean; messageId?: string }> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
  });
  if (!settings?.whitelistChannelId) return { posted: false, updated: false };

  const ch = await fetchTextChannel(guildId, settings.whitelistChannelId);
  if (!ch) return { posted: false, updated: false };

  const embed = new EmbedBuilder()
    .setTitle('Whitelist-System')
    .setColor(0x5865F2)
    .setDescription([
      'So beantragst du den Zutritt zum Server:',
      '',
      '`/whitelist id:<DEIN_INGAME_NAME>` — stellt eine Anfrage.',
      '',
      'Der Antrag wird **automatisch** an das zustaendige Server-Team weitergeleitet.',
      'Du bekommst eine Benachrichtigung, sobald ueber deinen Antrag entschieden wurde.',
      '',
      '**Wichtig:** Gib deinen exakten Spielernamen an (Gross-/Kleinschreibung beachten).',
    ].join('\n'))
    .setFooter({ text: 'V-Bot · Whitelist' })
    .setTimestamp(new Date());

  // Bestehende Nachricht updaten?
  if (settings.whitelistInfoMessageId) {
    const msg = await ch.messages.fetch(settings.whitelistInfoMessageId).catch(() => null);
    if (msg && msg.author.id === client()!.user!.id) {
      await msg.edit({ embeds: [embed] }).catch(() => null);
      return { posted: false, updated: true, messageId: msg.id };
    }
  }

  // Neu posten + ID speichern
  const sent = await ch.send({ embeds: [embed] });
  await prisma.serverSettings.update({
    where: { guildId_nitradoConnId: { guildId, nitradoConnId } },
    data: { whitelistInfoMessageId: sent.id },
  });
  return { posted: true, updated: false, messageId: sent.id };
}

/**
 * Postet das Approval-Embed (Admin-Aktion) im konfigurierten Request-Kanal.
 * Speichert die messageId im WhitelistRequest.
 */
export async function postWhitelistApprovalEmbed(args: {
  guildId: string; nitradoConnId: string; requestId: string;
  requesterDiscordId: string; gameId: string;
}): Promise<string | null> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId: args.guildId, nitradoConnId: args.nitradoConnId } },
  });
  if (!settings?.whitelistRequestChannelId) {
    logger.warn(`Whitelist: Kein Request-Channel konfiguriert (guild=${args.guildId} slot=${args.nitradoConnId})`);
    return null;
  }
  const ch = await fetchTextChannel(args.guildId, settings.whitelistRequestChannelId);
  if (!ch) return null;

  const embed = new EmbedBuilder()
    .setTitle('Neue Whitelist-Anfrage')
    .setColor(0xFEE75C)
    .addFields(
      { name: 'Antragsteller', value: `<@${args.requesterDiscordId}>`, inline: true },
      { name: 'Beantragter Spielername', value: `\`${args.gameId}\``, inline: true },
    )
    .setFooter({ text: `Request-ID: ${args.requestId}` })
    .setTimestamp(new Date());

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`wlreq:a:${args.requestId}`).setLabel('Annehmen').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`wlreq:d:${args.requestId}`).setLabel('Ablehnen').setStyle(ButtonStyle.Danger),
  );

  const sent = await ch.send({ embeds: [embed], components: [row] });
  await prisma.whitelistRequest.update({
    where: { id: args.requestId },
    data: { messageId: sent.id, channelId: ch.id },
  });
  return sent.id;
}

/**
 * Schickt dem User per DM eine Benachrichtigung (Anfrage eingegangen).
 * Failen ist harmlos (User hat DMs aus).
 */
export async function notifyRequesterPending(guildId: string, requesterDiscordId: string, gameId: string): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    const user = await c.users.fetch(requesterDiscordId);
    const embed = new EmbedBuilder()
      .setTitle('Whitelist-Anfrage eingegangen')
      .setColor(0x5865F2)
      .setDescription('Deine Anfrage wurde dem zustaendigen Server-Team weitergeleitet. Bitte warte auf die Entscheidung.')
      .addFields({ name: 'Beantragter Name', value: `\`${gameId}\`` })
      .setTimestamp(new Date());
    await user.send({ embeds: [embed] });
  } catch (e) {
    logger.warn(`Whitelist: DM an ${requesterDiscordId} fehlgeschlagen: ${(e as Error).message}`);
  }
}

/**
 * Schickt User die Entscheidung per DM.
 */
export async function notifyRequesterDecision(args: {
  requesterDiscordId: string; gameId: string; approved: boolean; reason?: string;
}): Promise<void> {
  const c = client();
  if (!c) return;
  try {
    const user = await c.users.fetch(args.requesterDiscordId);
    const embed = new EmbedBuilder()
      .setTitle(args.approved ? 'Whitelist-Anfrage angenommen' : 'Whitelist-Anfrage abgelehnt')
      .setColor(args.approved ? 0x57F287 : 0xED4245)
      .addFields({ name: 'Beantragter Name', value: `\`${args.gameId}\`` })
      .setTimestamp(new Date());
    if (args.reason) embed.addFields({ name: 'Begruendung', value: args.reason.slice(0, 1000) });
    if (args.approved) embed.setDescription('Du wurdest auf die Whitelist gesetzt. Viel Spass!');
    else embed.setDescription('Dein Antrag wurde abgelehnt.');
    await user.send({ embeds: [embed] });
  } catch (e) {
    logger.warn(`Whitelist: Entscheidungs-DM an ${args.requesterDiscordId} fehlgeschlagen: ${(e as Error).message}`);
  }
}

/**
 * Postet ins Approve- oder Deny-Log-Kanal. Strikt nur dort.
 */
export async function postDecisionLog(args: {
  guildId: string; nitradoConnId: string; approved: boolean;
  requesterDiscordId: string; gameId: string;
  decidedByDiscordId: string; reason?: string;
}): Promise<void> {
  const settings = await prisma.serverSettings.findUnique({
    where: { guildId_nitradoConnId: { guildId: args.guildId, nitradoConnId: args.nitradoConnId } },
  });
  const channelId = args.approved ? settings?.whitelistApproveLogChannelId : settings?.whitelistDenyLogChannelId;
  if (!channelId) return;
  const ch = await fetchTextChannel(args.guildId, channelId);
  if (!ch) return;

  const embed = new EmbedBuilder()
    .setTitle(args.approved ? 'Whitelist-Antrag angenommen' : 'Whitelist-Antrag abgelehnt')
    .setColor(args.approved ? 0x57F287 : 0xED4245)
    .addFields(
      { name: 'Antragsteller', value: `<@${args.requesterDiscordId}>`, inline: true },
      { name: 'Spielername', value: `\`${args.gameId}\``, inline: true },
      { name: args.approved ? 'Angenommen von' : 'Abgelehnt von', value: `<@${args.decidedByDiscordId}>`, inline: false },
    )
    .setTimestamp(new Date());
  if (args.reason) embed.addFields({ name: 'Begruendung', value: args.reason.slice(0, 1000) });

  await ch.send({ embeds: [embed] });
}
