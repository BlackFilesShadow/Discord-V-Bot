import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  MessageFlags,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import { logger } from '../../utils/logger';
import {
  listTriggers,
  addTrigger,
  removeTrigger,
  clearTriggers,
  MAX_TRIGGERS_PER_GUILD,
  AiTrigger,
} from '../../modules/ai/triggers';
import { saveAttachment, saveRemoteMedia, deleteMediaIfLocal } from '../../modules/ai/mediaStorage';
import { resolveCustomEmotes } from '../../modules/ai/emoteResolver';

export const aiTriggerCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ai-trigger')
    .setDescription(`AI- und Trigger-Verwaltung (max. ${MAX_TRIGGERS_PER_GUILD} pro Server)`)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc
      .setName('add')
      .setDescription('Neuen Trigger hinzufügen')
      .addStringOption(o => o.setName('id').setDescription('Eindeutige ID (a-z, 0-9, max 20)').setRequired(true))
      .addStringOption(o => o.setName('typ').setDescription('Trigger-Typ').setRequired(true)
        .addChoices(
          { name: 'Keyword (Substring)', value: 'keyword' },
          { name: 'Regex', value: 'regex' },
          { name: 'Mention (nur bei @V-Bot)', value: 'mention' },
        ))
      .addStringOption(o => o.setName('pattern').setDescription('Suchmuster').setRequired(true).setMaxLength(500))
      .addStringOption(o => o.setName('modus').setDescription('Antwort-Modus').setRequired(true)
        .addChoices(
          { name: 'Text (statisch, mit Variablen)', value: 'text' },
          { name: 'AI (generiert Antwort)', value: 'ai' },
        ))
      .addStringOption(o => o.setName('antwort').setDescription('Text ODER AI-Anweisung. Mehrere zufällige Antworten mit ||| trennen. Vars: {user} {time} {date}').setRequired(true).setMaxLength(2000))
      .addChannelOption(o => o.setName('channel').setDescription('Optional: Trigger nur in diesem Channel aktiv (leer = überall)').setRequired(false)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread, ChannelType.PrivateThread))
      .addAttachmentOption(o => o.setName('datei').setDescription('Optional: Bild/Video direkt hochladen (JPG/PNG/GIF/WEBP/MP4/WEBM/MOV, max 25 MB)').setRequired(false))
      .addStringOption(o => o.setName('media-url').setDescription('Optional: ALTERNATIV externe Bild-/Video-URL; Inhalt wird sicher geprüft').setRequired(false))
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
      .setDescription('Alle Trigger löschen')),
  adminOnly: true,
  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guildId) {
      await interaction.reply({ content: 'Nur in Servern verfügbar.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'add') {
      const id = interaction.options.getString('id', true).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
      if (!id) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription('❌ Ungültige ID.')] });
        return;
      }
      const triggerType = interaction.options.getString('typ', true) as AiTrigger['triggerType'];
      const pattern = interaction.options.getString('pattern', true);
      // K1: Regex-Pattern bei Erstellung validieren, sonst crasht jeder messageCreate-Match.
      if (triggerType === 'regex') {
        try {
          new RegExp(pattern);
        } catch (e) {
          await interaction.editReply({
            embeds: [vEmbed(Colors.Error).setDescription(`❌ Ungültiger Regex: ${(e as Error).message}`)],
          });
          return;
        }
      }
      const responseMode = interaction.options.getString('modus', true) as AiTrigger['responseMode'];
      const antwortRaw = interaction.options.getString('antwort', true);
      // Custom-Emojis :name: -> <:name:id> auflösen (nur für text-Modus sinnvoll, aber harmlos für ai)
      const antwort = resolveCustomEmotes(antwortRaw, interaction.guild);
      const channelOpt = interaction.options.getChannel('channel');
      const channelId = channelOpt?.id;
      const mediaUrl = interaction.options.getString('media-url') || undefined;
      const mediaAttachment = interaction.options.getAttachment('datei') || undefined;
      const cooldown = interaction.options.getInteger('cooldown') ?? 10;

      if (mediaUrl && mediaAttachment) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setDescription('❌ Bitte entweder `datei` ODER `media-url` angeben, nicht beides.')],
        });
        return;
      }

      // Alten Zustand VOR der neuen Ingestion lesen. Ab hier darf ein Fehler
      // keine bereits aktive Media-Datei verändern.
      const existing = (await listTriggers(guildId)).find(t => t.id === id);
      const oldMediaToDelete = existing?.mediaUrl;

      // Beide Eingabepfade enden als neu materialisierte lokale Datei. Damit
      // bleiben keine nutzergesteuerten Remote-URLs als aktive Trigger-Quelle
      // bestehen und DNS-/Redirect-SSRF wird zentral geprüft.
      let media: string | undefined;
      let createdLocalMedia = false;
      if (mediaAttachment) {
        const saved = await saveAttachment(mediaAttachment, 'triggers', guildId, id);
        if (!saved.ok || !saved.localPath) {
          await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription(saved.message)] });
          return;
        }
        media = saved.localPath;
        createdLocalMedia = true;
      } else if (mediaUrl) {
        const saved = await saveRemoteMedia(mediaUrl, 'triggers', guildId, id);
        if (!saved.ok || !saved.localPath) {
          await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription(saved.message)] });
          return;
        }
        media = saved.localPath;
        createdLocalMedia = true;
      }

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

      let result: Awaited<ReturnType<typeof addTrigger>>;
      try {
        result = await addTrigger(guildId, trigger);
      } catch (error) {
        if (createdLocalMedia && media) await deleteMediaIfLocal(media);
        logger.error('AI-Trigger konnte nicht gespeichert werden:', error as Error);
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setDescription('❌ Trigger konnte nicht gespeichert werden.')],
        });
        return;
      }

      if (result.ok) {
        // Erst NACH erfolgreicher Persistenz die vorher aktive Datei entfernen.
        if (oldMediaToDelete && oldMediaToDelete !== media) {
          await deleteMediaIfLocal(oldMediaToDelete);
        }
      } else if (createdLocalMedia && media) {
        // Fachlicher Add-Fehler: neue Datei zurückrollen, alte bleibt aktiv.
        await deleteMediaIfLocal(media);
      }

      const embed = vEmbed(result.ok ? Colors.Success : Colors.Error)
        .setTitle(result.ok ? '✅ Trigger hinzugefügt' : '❌ Fehler')
        .setDescription(result.message);
      if (result.ok) {
        const mediaDisplay = media ? `📎 ${media.split(/[\\/]/).pop()} (lokal gespeichert)` : null;
        embed.addFields(
          { name: 'ID', value: id, inline: true },
          { name: 'Typ', value: triggerType, inline: true },
          { name: 'Modus', value: responseMode, inline: true },
          { name: 'Pattern', value: `\`${pattern.slice(0, 200)}\``, inline: false },
          { name: 'Channel', value: channelId ? `<#${channelId}>` : '_überall_', inline: true },
          { name: 'Cooldown', value: `${cooldown}s`, inline: true },
          ...(mediaDisplay ? [{ name: 'Media', value: mediaDisplay, inline: false }] : []),
        );
      }
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'list') {
      const list = await listTriggers(guildId);
      const shown = list.slice(0, 10);
      const embed = vEmbed(Colors.Info)
        .setTitle(`🤖 AI-Trigger (${list.length}/${MAX_TRIGGERS_PER_GUILD})`);
      if (list.length === 0) {
        embed.setDescription('_Keine Trigger konfiguriert._\n\nFüge welche mit `/ai-trigger add` hinzu.');
      } else {
        if (list.length > shown.length) {
          embed.setDescription(`_Zeige erste ${shown.length} von ${list.length} Triggern._`);
        }
        for (const t of shown) {
          const preview = t.responseMode === 'text'
            ? (t.responseText || '').slice(0, 100)
            : `(AI) ${(t.aiPrompt || '').slice(0, 100)}`;
          const channelInfo = t.channelId ? ` • <#${t.channelId}>` : '';
          embed.addFields({
            name: `\`${t.id}\` • ${t.triggerType} • ${t.responseMode}${t.mediaUrl ? ' 📎' : ''}`,
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
      // Erst DB-Eintrag entfernen, dann Media: sonst kann Media weg sein, während
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
        embeds: [vEmbed(Colors.Success).setDescription('✅ Alle Trigger gelöscht.')],
      });
      return;
    }
  },
};

export default aiTriggerCommand;
