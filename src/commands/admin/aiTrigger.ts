import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import {
  listTriggers,
  addTrigger,
  removeTrigger,
  clearTriggers,
  MAX_TRIGGERS_PER_GUILD,
  AiTrigger,
} from '../../modules/ai/triggers';
import { saveAttachment, deleteMediaIfLocal } from '../../modules/ai/mediaStorage';
import { resolveCustomEmotes } from '../../modules/ai/emoteResolver';

const SUPPORTED_MEDIA = /\.(jpe?g|png|gif|webp|mp4|webm|mov)(\?.*)?$/i;

export const aiTriggerCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ai-trigger')
    .setDescription(`AI- und Trigger-Verwaltung (max. ${MAX_TRIGGERS_PER_GUILD} pro Server)`)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc
      .setName('add')
      .setDescription('Neuen Trigger hinzuf\u00fcgen')
      .addStringOption(o => o.setName('id').setDescription('Eindeutige ID (a-z, 0-9, max 20)').setRequired(true))
      .addStringOption(o => o.setName('typ').setDescription('Trigger-Typ').setRequired(true)
        .addChoices(
          { name: 'Keyword (Substring)', value: 'keyword' },
          { name: 'Regex', value: 'regex' },
          { name: 'Mention (nur bei @V-Bot)', value: 'mention' },
        ))
      .addStringOption(o => o.setName('pattern').setDescription('Suchmuster').setRequired(true))
      .addStringOption(o => o.setName('modus').setDescription('Antwort-Modus').setRequired(true)
        .addChoices(
          { name: 'Text (statisch, mit Variablen)', value: 'text' },
          { name: 'AI (generiert Antwort)', value: 'ai' },
        ))
      .addStringOption(o => o.setName('antwort').setDescription('Text ODER AI-Anweisung. Mehrere zuf\u00e4llige Antworten mit ||| trennen. Vars: {user} {time} {date}').setRequired(true))
      .addChannelOption(o => o.setName('channel').setDescription('Optional: Trigger nur in diesem Channel aktiv (leer = \u00fcberall)').setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread))
      .addAttachmentOption(o => o.setName('datei').setDescription('Optional: Bild/Video direkt hochladen (JPG/PNG/GIF/WEBP/MP4/WEBM/MOV, max 25 MB)').setRequired(false))
      .addStringOption(o => o.setName('media-url').setDescription('Optional: ALTERNATIV externe URL zu JPG/PNG/GIF/MP4/WEBM').setRequired(false))
      .addIntegerOption(o => o.setName('cooldown').setDescription('Cooldown in Sekunden (Standard: 10)').setRequired(false).setMinValue(0).setMaxValue(3600))
    )
    .addSubcommand(sc => sc
      .setName('list')
      .setDescription('Alle Trigger dieses Servers anzeigen'))
    .addSubcommand(sc => sc
      .setName('remove')
      .setDescription('Trigger entfernen')
      .addStringOption(o => o.setName('id').setDescription('Trigger-ID').setRequired(true)))
    .addSubcommand(sc => sc
      .setName('clear')
      .setDescription('Alle Trigger l\u00f6schen')),

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Nur in Servern verf\u00fcgbar.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'add') {
      const id = interaction.options.getString('id', true).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
      if (!id) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription('\u274c Ung\u00fcltige ID.')] });
        return;
      }
      const triggerType = interaction.options.getString('typ', true) as AiTrigger['triggerType'];
      const pattern = interaction.options.getString('pattern', true);
      const responseMode = interaction.options.getString('modus', true) as AiTrigger['responseMode'];
      const antwortRaw = interaction.options.getString('antwort', true);
      // Custom-Emojis :name: -> <:name:id> aufl\u00f6sen (nur f\u00fcr text-Modus sinnvoll, aber harmlos f\u00fcr ai)
      const antwort = resolveCustomEmotes(antwortRaw, interaction.guild);
      const channelOpt = interaction.options.getChannel('channel');
      const channelId = channelOpt?.id;
      const mediaUrl = interaction.options.getString('media-url') || undefined;
      const mediaAttachment = interaction.options.getAttachment('datei') || undefined;
      const cooldown = interaction.options.getInteger('cooldown') ?? 10;

      // Konflikt: nicht beides gleichzeitig
      if (mediaUrl && mediaAttachment) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setDescription('\u274c Bitte entweder `datei` ODER `media-url` angeben, nicht beides.')],
        });
        return;
      }

      // URL-Validierung (falls URL-Pfad gew\u00e4hlt)
      if (mediaUrl && !SUPPORTED_MEDIA.test(mediaUrl)) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setDescription('\u274c Media-URL muss auf .jpg/.png/.gif/.webp/.mp4/.webm/.mov enden.')],
        });
        return;
      }
      if (mediaUrl && !/^https?:\/\//i.test(mediaUrl)) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setDescription('\u274c Media-URL muss mit http(s):// beginnen.')],
        });
        return;
      }

      // Datei-Upload herunterladen + persistent speichern
      let media: string | undefined = mediaUrl;
      if (mediaAttachment) {
        const saved = await saveAttachment(mediaAttachment, 'triggers', guildId, id);
        if (!saved.ok || !saved.localPath) {
          await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription(saved.message)] });
          return;
        }
        media = saved.localPath;
      }

      // Falls Trigger mit gleicher ID schon Media hatte: alte Datei merken,
      // aber ERST nach erfolgreichem DB-Add l\u00f6schen (Race-Schutz).
      const existing = (await listTriggers(guildId)).find(t => t.id === id);
      const oldMediaToDelete = existing?.mediaUrl;

      const trigger: AiTrigger = {
        id,
        trigger: pattern,
        triggerType,
        responseMode,
        responseText: responseMode === 'text' ? antwort : undefined,
        aiPrompt: responseMode === 'ai' ? antwort : undefined,
        mediaUrl: media,
        channelId,
        cooldownSeconds: cooldown,
        createdAt: new Date().toISOString(),
        createdBy: interaction.user.id,
      };

      const result = await addTrigger(guildId, trigger);
      if (result.ok) {
        // Add erfolgreich: alte Media erst jetzt entfernen
        if (oldMediaToDelete) {
          await deleteMediaIfLocal(oldMediaToDelete);
        }
      } else {
        // Add fehlgeschlagen: gerade hochgeladene neue Media wieder l\u00f6schen,
        // damit kein verwaister Upload zur\u00fcckbleibt.
        if (mediaAttachment && media && !media.startsWith('http')) {
          await deleteMediaIfLocal(media);
        }
      }
      const embed = vEmbed(result.ok ? Colors.Success : Colors.Error)
        .setTitle(result.ok ? '\u2705 Trigger hinzugef\u00fcgt' : '\u274c Fehler')
        .setDescription(result.message);
      if (result.ok) {
        const mediaDisplay = media
          ? (media.startsWith('http') ? media : `\ud83d\udcce ${media.split('/').pop()} (lokal gespeichert)`)
          : null;
        embed.addFields(
          { name: 'ID', value: id, inline: true },
          { name: 'Typ', value: triggerType, inline: true },
          { name: 'Modus', value: responseMode, inline: true },
          { name: 'Pattern', value: `\`${pattern.slice(0, 200)}\``, inline: false },
          { name: 'Channel', value: channelId ? `<#${channelId}>` : '_\u00fcberall_', inline: true },
          { name: 'Cooldown', value: `${cooldown}s`, inline: true },
          ...(mediaDisplay ? [{ name: 'Media', value: mediaDisplay, inline: false }] : []),
        );
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'list') {
      const list = await listTriggers(guildId);
      const embed = vEmbed(Colors.Info)
        .setTitle(`\ud83e\udd16 AI-Trigger (${list.length}/${MAX_TRIGGERS_PER_GUILD})`);
      if (list.length === 0) {
        embed.setDescription('_Keine Trigger konfiguriert._\n\nF\u00fcge welche mit `/ai-trigger add` hinzu.');
      } else {
        for (const t of list.slice(0, 10)) {
          const preview = t.responseMode === 'text'
            ? (t.responseText || '').slice(0, 100)
            : `(AI) ${(t.aiPrompt || '').slice(0, 100)}`;
          const channelInfo = t.channelId ? ` \u2022 <#${t.channelId}>` : '';
          embed.addFields({
            name: `\`${t.id}\` \u2022 ${t.triggerType} \u2022 ${t.responseMode}${t.mediaUrl ? ' \ud83d\udcce' : ''}`,
            value: `**Pattern:** \`${t.trigger.slice(0, 80)}\`${channelInfo}\n**Antwort:** ${preview}\n**Cooldown:** ${t.cooldownSeconds}s`,
            inline: false,
          });
        }
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'remove') {
      const id = interaction.options.getString('id', true);
      const existing = (await listTriggers(guildId)).find(t => t.id === id);
      // Erst DB-Eintrag entfernen, dann Media: sonst kann Media weg sein, w\u00e4hrend
      // der Trigger noch in der DB steht und ins Leere zeigt.
      const result = await removeTrigger(guildId, id, interaction.user.id);
      if (result.ok && existing?.mediaUrl) {
        await deleteMediaIfLocal(existing.mediaUrl);
      }
      await interaction.editReply({
        embeds: [vEmbed(result.ok ? Colors.Success : Colors.Error).setDescription(result.message)],
      });
      return;
    }

    if (sub === 'clear') {
      const all = await listTriggers(guildId);
      // Erst DB leeren, dann Media: verhindert verwaiste Triggers ohne Media.
      await clearTriggers(guildId, interaction.user.id);
      for (const t of all) {
        if (t.mediaUrl) await deleteMediaIfLocal(t.mediaUrl);
      }
      await interaction.editReply({
        embeds: [vEmbed(Colors.Success).setDescription('\u2705 Alle Trigger gel\u00f6scht.')],
      });
      return;
    }
  },
};

export default aiTriggerCommand;
