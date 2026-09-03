import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  type Client,
  type GuildTextBasedChannel,
} from 'discord.js';
import prisma from '../../database/prisma';
import { vEmbed } from '../../utils/embedDesign';

export const LINKING_CHANNEL_PERMISSIONS = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
] as const;

export function buildLinkingInfoEmbed(serverLabel: string): EmbedBuilder {
  return vEmbed(0x5865F2)
    .setTitle('🔗 Discord mit DayZ verbinden')
    .setDescription(
      `Verbinde deinen Discord-Account mit deinem Spieler auf **${serverLabel}**.\n\n`
      + '**So funktioniert es:**\n'
      + '1. Spiele zunächst mindestens **5 Minuten** auf dem DayZ-Server.\n'
      + '2. Nutze `/link` und gib deinen **exakten PSN-/Xbox-/DayZ-Spielernamen** ein.\n'
      + '3. V-Bot prüft automatisch die bereits erfassten ADM-/Session-Daten und die dazugehörige DayZ-GUID.\n'
      + '4. Ist die Mindestspielzeit erreicht und Name/GUID sind noch frei, wird dein Discord-Account automatisch verknüpft.\n\n'
      + 'Danach können aktivierte Spielzeit- und Server-Rewards eindeutig deinem Discord-Account gutgeschrieben werden.',
    )
    .addFields({
      name: 'Wichtig',
      value: 'Ein Spielername bzw. eine DayZ-GUID kann nur einem Discord-Account gehören. Gib den Namen exakt so ein, wie er auf dem Server erkannt wird.',
    });
}

async function serverLabel(guildId: string, nitradoConnId: string): Promise<string> {
  const row = await prisma.nitradoConnection.findFirst({
    where: { id: nitradoConnId, guildId },
    select: { alias: true },
  });
  return row?.alias?.trim() || 'ausgewählter DayZ-Server';
}

export async function resolveLinkingTextChannel(
  client: Client,
  guildId: string,
  channelId: string,
): Promise<{ ok: true; channel: GuildTextBasedChannel } | { ok: false; reason: string }> {
  const guild = await client.guilds.fetch(guildId).catch(() => null);
  if (!guild) return { ok: false, reason: 'Discord-Server nicht erreichbar.' };
  const raw = await guild.channels.fetch(channelId).catch(() => null);
  if (!raw
    || (raw.type !== ChannelType.GuildText && raw.type !== ChannelType.GuildAnnouncement)
    || raw.guildId !== guildId) {
    return { ok: false, reason: 'Wähle einen Text- oder Ankündigungskanal dieses Discord-Servers.' };
  }
  const me = guild.members.me ?? await guild.members.fetchMe().catch(() => null);
  const permissions = me ? raw.permissionsFor(me) : null;
  if (!permissions || LINKING_CHANNEL_PERMISSIONS.some(permission => !permissions.has(permission))) {
    return {
      ok: false,
      reason: 'V-Bot benötigt im Zielkanal Kanal ansehen, Nachrichten senden und Links einbetten.',
    };
  }
  return { ok: true, channel: raw as GuildTextBasedChannel };
}

/**
 * Erstellt oder aktualisiert genau einen persistenten Info-Embed pro
 * Guild+Nitrado-Verbindung. Wurde die alte Nachricht gelöscht oder der Kanal
 * gewechselt, wird automatisch eine neue Nachricht erzeugt und deren ID
 * ausschliesslich intern gespeichert.
 */
export async function publishLinkingInfoEmbed(args: {
  client: Client;
  guildId: string;
  nitradoConnId: string;
  channelId: string;
}): Promise<{ ok: true; channelId: string; messageId: string } | { ok: false; reason: string }> {
  const resolved = await resolveLinkingTextChannel(args.client, args.guildId, args.channelId);
  if (!resolved.ok) return resolved;

  const existing = await prisma.linkingChannelConfig.findUnique({
    where: {
      guildId_nitradoConnId: {
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
      },
    },
  });
  const embed = buildLinkingInfoEmbed(await serverLabel(args.guildId, args.nitradoConnId));

  let messageId: string | null = null;
  if (existing?.channelId === args.channelId && existing.infoMessageId) {
    const existingMessage = await resolved.channel.messages.fetch(existing.infoMessageId).catch(() => null);
    if (existingMessage) {
      await existingMessage.edit({ embeds: [embed], allowedMentions: { parse: [] } });
      messageId = existingMessage.id;
    }
  }

  if (!messageId) {
    const sent = await resolved.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    messageId = sent.id;
  }

  await prisma.linkingChannelConfig.upsert({
    where: {
      guildId_nitradoConnId: {
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
      },
    },
    create: {
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      channelId: args.channelId,
      infoMessageId: messageId,
    },
    update: {
      channelId: args.channelId,
      infoMessageId: messageId,
    },
  });

  return { ok: true, channelId: args.channelId, messageId };
}

export async function repostConfiguredLinkingInfoEmbed(args: {
  client: Client;
  guildId: string;
  nitradoConnId: string;
}): Promise<{ ok: true; channelId: string; messageId: string } | { ok: false; reason: string }> {
  const existing = await prisma.linkingChannelConfig.findUnique({
    where: {
      guildId_nitradoConnId: {
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
      },
    },
  });
  if (!existing) return { ok: false, reason: 'Für diesen Gameserver ist noch kein Verknüpfungs-Kanal konfiguriert.' };
  return publishLinkingInfoEmbed({ ...args, channelId: existing.channelId });
}
