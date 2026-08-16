import {
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
} from 'discord.js';
import type { Command } from '../../types';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { withGuildScope } from '../middleware/withGuildScope';
import { MAX_GAME_SERVERS_PER_GUILD } from '../../modules/nitrado/gameServerScope';
import {
  MIN_LINK_PLAYTIME_SECONDS,
  findVerifiedLinkDetails,
  isValidPlayerName,
  linkByPlayerName,
  listVerifiedLinkDetails,
  unlinkUser,
  type LinkClient,
  type PlayerNameLinkResult,
  type SessionLinkClient,
} from '../../modules/linking/linkService';
import { buildStatusEmbed, type EmbedStatus } from '../../utils/statusEmbed';
import { logAudit } from '../../utils/logger';

function slotOption(builder: SlashCommandBuilder): SlashCommandBuilder {
  return builder.addIntegerOption(option => option
    .setName('slot')
    .setDescription('Gameserver-Slot (bei mehreren Servern erforderlich)')
    .setRequired(false)
    .setMinValue(1)
    .setMaxValue(MAX_GAME_SERVERS_PER_GUILD)) as SlashCommandBuilder;
}

async function statusReply(
  interaction: ChatInputCommandInteraction,
  status: EmbedStatus,
  title: string,
  description: string,
  fields: { name: string; value: string; inline?: boolean }[] = [],
): Promise<void> {
  const embed = buildStatusEmbed({
    status,
    title,
    description,
    fields,
    footerText: 'V-Bot • Account-Verknüpfung',
  });
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  });
}

function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return `${minutes} Min ${String(rest).padStart(2, '0')} Sek`;
}

function linkFailureCopy(result: Extract<PlayerNameLinkResult, { ok: false }>): {
  status: EmbedStatus;
  title: string;
  description: string;
  fields?: { name: string; value: string }[];
} {
  switch (result.reason) {
    case 'PLAYER_NOT_SEEN':
      return {
        status: 'INFO',
        title: 'Spieler noch nicht erkannt',
        description: `Der Spielername **${result.playerName || '—'}** wurde auf diesem DayZ-Server noch nicht in den ADM-/Session-Daten erkannt. Spiele zuerst auf dem Server und versuche \`/link\` danach erneut.`,
      };
    case 'PLAYTIME_TOO_SHORT': {
      const played = result.playedSeconds ?? 0;
      const required = result.requiredSeconds ?? MIN_LINK_PLAYTIME_SECONDS;
      return {
        status: 'INFO',
        title: '⏳ Noch nicht lange genug gespielt',
        description: `**${result.playerName}** wurde bereits erkannt, die Mindestspielzeit für die automatische Verknüpfung ist aber noch nicht erreicht.`,
        fields: [
          { name: 'Aktuell erkannt', value: formatDuration(played) },
          { name: 'Erforderlich', value: formatDuration(required) },
          { name: 'Noch offen', value: formatDuration(Math.max(0, required - played)) },
        ],
      };
    }
    case 'AMBIGUOUS_PLAYER_NAME':
      return {
        status: 'ERROR',
        title: 'Spielername nicht eindeutig',
        description: `Der exakte Name **${result.playerName}** wurde mit mehreren DayZ-GUIDs beobachtet. Aus Sicherheitsgründen wird keine davon automatisch übernommen. Bitte wende dich an das Server-Team.`,
      };
    case 'PLAYER_NAME_TAKEN':
    case 'IDENTITY_TAKEN':
      return {
        status: 'ERROR',
        title: 'Spieler bereits verknüpft',
        description: `**${result.playerName}** bzw. die dazugehörige DayZ-GUID ist bereits mit einem anderen Discord-Account verbunden. Ein Spielername/GUID kann nur einem Discord-Account gehören.`,
      };
    case 'USER_ALREADY_LINKED':
      return {
        status: 'ERROR',
        title: 'Discord-Account bereits verknüpft',
        description: 'Dein Discord-Account ist auf diesem Gameserver bereits mit einer anderen DayZ-Identität verbunden. Entferne die bestehende Verbindung zuerst mit `/unlink` oder wende dich an das Server-Team.',
      };
  }
}

async function serverLabel(guildId: string, nitradoConnId: string): Promise<string> {
  const row = await prisma.nitradoConnection.findFirst({
    where: { id: nitradoConnId, guildId },
    select: { alias: true, slot: true },
  });
  return row ? `${row.alias} (Slot ${row.slot})` : 'ausgewählter DayZ-Server';
}

export const linkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('link')
    .setDescription('Verknüpft Discord nach 5 Minuten Spielzeit mit deinem PSN-/Xbox-/DayZ-Namen.')
    .addStringOption(option => option
      .setName('id')
      .setDescription('Exakter PSN-/Xbox-/DayZ-Spielername')
      .setRequired(true)
      .setMinLength(1)
      .setMaxLength(64)) as SlashCommandBuilder),
  execute: withGuildScope({ acceptSlotOption: true }, async (interaction, scope) => {
    const playerName = interaction.options.getString('id', true).trim();
    if (!isValidPlayerName(playerName)) {
      await statusReply(interaction, 'ERROR', 'Ungültiger Spielername', 'Der Spielername muss 1–64 Zeichen lang sein und darf keine Zeilenumbrüche enthalten.');
      return;
    }

    const result = await linkByPlayerName(
      prisma as unknown as SessionLinkClient,
      { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      scope.actorDiscordId,
      playerName,
      config.security.encryptionKey,
    );

    if (!result.ok) {
      const copy = linkFailureCopy(result);
      await statusReply(interaction, copy.status, copy.title, copy.description, copy.fields);
      return;
    }

    logAudit(result.alreadyLinked ? 'LINK_ALREADY_VERIFIED' : 'LINK_SESSION_VERIFIED', 'LINKING', {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
      playerName: result.playerName,
      playedSeconds: result.playedSeconds,
    });

    await statusReply(
      interaction,
      'SUCCESS',
      result.alreadyLinked ? 'Bereits verknüpft' : '✅ Verknüpfung erfolgreich',
      result.alreadyLinked
        ? `Dein Discord-Account ist bereits korrekt mit **${result.playerName}** verbunden.`
        : `Dein Discord-Account wurde mit **${result.playerName}** verbunden. Zukünftige serverseitige Aktivitäten dieser DayZ-GUID können damit deinem Discord-Account und den aktivierten Economy-Rewards eindeutig zugeordnet werden.`,
      [
        { name: 'Spielername', value: result.playerName },
        { name: 'Nachgewiesene Spielzeit', value: formatDuration(result.playedSeconds) },
      ],
    );
  }),
};

export const unlinkCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('unlink')
    .setDescription('Entfernt deine aktive Discord ↔ DayZ-Verknüpfung auf diesem Gameserver.') as SlashCommandBuilder),
  execute: withGuildScope({ acceptSlotOption: true }, async (interaction, scope) => {
    const removed = await unlinkUser(
      prisma as unknown as LinkClient,
      { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      scope.actorDiscordId,
    );
    if (!removed) {
      await statusReply(interaction, 'INFO', 'Keine aktive Verknüpfung', 'Für deinen Discord-Account existiert auf diesem Gameserver keine aktive Verknüpfung.');
      return;
    }
    logAudit('LINK_DELETED', 'LINKING', {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
    });
    await statusReply(interaction, 'SUCCESS', 'Verknüpfung entfernt', 'Die aktive Zuordnung wurde entfernt. Historische Economy-/Auditdaten bleiben unverändert bestehen.');
  }),
};

export const linksCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('links')
    .setDescription('Berechtigt: Listet Discord-Account, Spielername und aktuelle DayZ-GUID.') as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.view', acceptSlotOption: true }, async (interaction, scope) => {
    const rows = await listVerifiedLinkDetails(
      prisma as unknown as SessionLinkClient,
      { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      config.security.encryptionKey,
      100,
    );
    if (rows.length === 0) {
      await statusReply(interaction, 'INFO', 'Verknüpfungen', 'Auf diesem Gameserver gibt es noch keine aktiven Verknüpfungen.');
      return;
    }

    const lines = rows.map((row, index) => {
      const name = row.playerName ?? 'Name nicht mehr in Session-Historie';
      const guid = row.gameId ?? 'GUID nicht mehr auflösbar';
      return `**${index + 1}.** <@${row.userDiscordId}>\n↳ **${name}** · \`${guid}\``;
    });
    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`🔗 Aktive Spieler-Verknüpfungen (${rows.length})`)
      .setDescription(lines.join('\n').slice(0, 4000))
      .setFooter({ text: await serverLabel(scope.guildId, scope.nitradoConnId!) });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }),
};

export const linkInfoCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('link-info')
    .setDescription('Berechtigt: Prüft, welcher Discord-Account mit Name oder GUID verbunden ist.')
    .addUserOption(option => option
      .setName('user')
      .setDescription('Discord-Account prüfen')
      .setRequired(false))
    .addStringOption(option => option
      .setName('id')
      .setDescription('Exakter Spielername oder aktuelle DayZ-GUID')
      .setRequired(false)
      .setMaxLength(128)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.view', acceptSlotOption: true }, async (interaction, scope) => {
    const user = interaction.options.getUser('user');
    const identifier = interaction.options.getString('id')?.trim();
    if (!user && !identifier) {
      await statusReply(interaction, 'INFO', 'Suchwert erforderlich', 'Gib entweder `user` oder `id` (Spielername/GUID) an.');
      return;
    }

    const rows = await findVerifiedLinkDetails(
      prisma as unknown as SessionLinkClient,
      { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId! },
      config.security.encryptionKey,
      user ? { userDiscordId: user.id } : { identifier },
    );
    if (rows.length === 0) {
      await statusReply(interaction, 'INFO', 'Keine Verknüpfung gefunden', 'Für diese Suche existiert auf dem ausgewählten Gameserver keine aktive Verknüpfung.');
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🔎 Link-Information')
      .setFooter({ text: await serverLabel(scope.guildId, scope.nitradoConnId!) });
    for (const row of rows.slice(0, 10)) {
      embed.addFields({
        name: row.playerName ?? 'Unbekannter Spielername',
        value: [
          `Discord: <@${row.userDiscordId}>`,
          `GUID: \`${row.gameId ?? 'nicht auflösbar'}\``,
          `Verknüpft: ${row.verifiedAt ? `<t:${Math.floor(row.verifiedAt.getTime() / 1000)}:R>` : 'unbekannt'}`,
        ].join('\n'),
        inline: false,
      });
    }
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  }),
};

export const linkPanelCommand: Command = {
  data: slotOption(new SlashCommandBuilder()
    .setName('link-panel')
    .setDescription('Berechtigt: Sendet den Account-Verknüpfungs-Embed in einen Discord-Kanal.')
    .addChannelOption(option => option
      .setName('channel')
      .setDescription('Kanal für die Verknüpfungs-Anleitung')
      .setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)) as SlashCommandBuilder),
  execute: withGuildScope({ requirePerm: 'economy.manage', acceptSlotOption: true }, async (interaction, scope) => {
    const rawChannel = interaction.options.getChannel('channel', true);
    if (!rawChannel.isTextBased() || rawChannel.isDMBased() || rawChannel.guildId !== scope.guildId) {
      await statusReply(interaction, 'ERROR', 'Kanal nicht geeignet', 'Wähle einen Text- oder Ankündigungskanal dieses Discord-Servers.');
      return;
    }
    const channel = rawChannel as GuildTextBasedChannel;
    const me = interaction.guild?.members.me;
    const permissions = me && 'permissionsFor' in channel ? channel.permissionsFor(me) : null;
    if (!permissions?.has(PermissionFlagsBits.ViewChannel)
      || !permissions.has(PermissionFlagsBits.SendMessages)
      || !permissions.has(PermissionFlagsBits.EmbedLinks)) {
      await statusReply(interaction, 'ERROR', 'Bot-Berechtigungen fehlen', 'V-Bot benötigt im Zielkanal **Kanal ansehen**, **Nachrichten senden** und **Links einbetten**.');
      return;
    }

    const label = await serverLabel(scope.guildId, scope.nitradoConnId!);
    const panel = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle('🔗 Discord mit DayZ verbinden')
      .setDescription(
        `Verbinde deinen Discord-Account mit deinem Spieler auf **${label}**.\n\n`
        + '**So funktioniert es:**\n'
        + '1. Spiele zunächst mindestens **5 Minuten** auf dem DayZ-Server.\n'
        + '2. Nutze `/link` und gib bei `id` deinen **exakten PSN-/Xbox-/DayZ-Spielernamen** ein.\n'
        + '3. V-Bot prüft automatisch die bereits erfassten ADM-/Session-Daten und die dazugehörige DayZ-GUID.\n'
        + '4. Ist die Mindestspielzeit erreicht und Name/GUID sind noch frei, wird dein Discord-Account automatisch verknüpft.\n\n'
        + 'Danach können aktivierte Spielzeit- und Server-Rewards eindeutig deinem Discord-Account gutgeschrieben werden.',
      )
      .addFields({
        name: 'Wichtig',
        value: 'Ein Spielername bzw. eine DayZ-GUID kann nur einem Discord-Account gehören. Gib den Namen exakt so ein, wie er auf dem Server erkannt wird.',
      });

    try {
      await channel.send({ embeds: [panel], allowedMentions: { parse: [] } });
    } catch {
      await statusReply(interaction, 'ERROR', 'Embed konnte nicht gesendet werden', 'Der Zielkanal konnte nicht beschrieben werden. Prüfe die Kanalberechtigungen des Bots.');
      return;
    }

    logAudit('LINK_PANEL_POSTED', 'LINKING', {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
      actor: scope.actorDiscordId,
      channelId: channel.id,
    });
    await statusReply(interaction, 'SUCCESS', 'Verknüpfungs-Embed gesendet', `Die Anleitung wurde in <#${channel.id}> veröffentlicht.`);
  }),
};
