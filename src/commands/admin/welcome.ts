import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  PermissionFlagsBits,
  ChannelType,
  TextChannel,
  AttachmentBuilder,
} from 'discord.js';
import { Command } from '../../types';
import { Colors, vEmbed } from '../../utils/embedDesign';
import {
  getWelcomeConfig,
  setWelcomeConfig,
  disableWelcome,
  renderWelcomeMessage,
} from '../../modules/welcome/welcomeManager';
import { answerQuestion, BOT_PERSONA } from '../../modules/ai/aiHandler';
import { sanitizeForPrompt, withTimeout } from '../../utils/safeSend';
import { saveAttachment, deleteMediaIfLocal } from '../../modules/ai/mediaStorage';
import { resolveCustomEmotes } from '../../modules/ai/emoteResolver';

const SUPPORTED_MEDIA = /\.(jpe?g|png|gif|webp|mp4|webm|mov)(\?.*)?$/i;

export const welcomeCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('welcome')
    .setDescription('Willkommens-System konfigurieren')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc
      .setName('set')
      .setDescription('Willkommensnachricht einrichten')
      .addChannelOption(o => o.setName('channel').setDescription('Begr\u00fc\u00dfungs-Channel').setRequired(true)
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addStringOption(o => o.setName('modus').setDescription('Antwort-Modus').setRequired(true)
        .addChoices(
          { name: 'Text (statisch)', value: 'text' },
          { name: 'AI (pers\u00f6nliche Begr\u00fc\u00dfung)', value: 'ai' },
        ))
      .addStringOption(o => o.setName('nachricht').setDescription('Text ODER AI-Anweisung. Vars: {user} {guild} {count} {date} {time} {year}').setRequired(true))
      .addAttachmentOption(o => o.setName('datei').setDescription('Optional: Bild/Video direkt hochladen (JPG/PNG/GIF/WEBP/MP4/WEBM/MOV, max 25 MB)').setRequired(false))
      .addStringOption(o => o.setName('media-url').setDescription('Optional: ALTERNATIV externe URL').setRequired(false))
    )
    .addSubcommand(sc => sc
      .setName('test')
      .setDescription('Test-Begr\u00fc\u00dfung im konfigurierten Channel ausl\u00f6sen'))
    .addSubcommand(sc => sc
      .setName('show')
      .setDescription('Aktuelle Konfiguration anzeigen'))
    .addSubcommand(sc => sc
      .setName('disable')
      .setDescription('Willkommens-System deaktivieren')),

  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guildId || !interaction.guild) {
      await interaction.reply({ content: 'Nur in Servern verf\u00fcgbar.', ephemeral: true });
      return;
    }
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;

    if (sub === 'set') {
      const channel = interaction.options.getChannel('channel', true);
      const mode = interaction.options.getString('modus', true) as 'text' | 'ai';
      const messageRaw = interaction.options.getString('nachricht', true);
      const message = resolveCustomEmotes(messageRaw, interaction.guild);
      const mediaUrl = interaction.options.getString('media-url') || undefined;
      const mediaAttachment = interaction.options.getAttachment('datei') || undefined;

      if (mediaUrl && mediaAttachment) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setDescription('\u274c Bitte entweder `datei` ODER `media-url` angeben, nicht beides.')],
        });
        return;
      }
      if (mediaUrl && (!SUPPORTED_MEDIA.test(mediaUrl) || !/^https?:\/\//i.test(mediaUrl))) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setDescription('\u274c Media-URL ung\u00fcltig. Erlaubt: http(s):// + .jpg/.png/.gif/.webp/.mp4/.webm/.mov')],
        });
        return;
      }

      // Vorherige lokale Datei aufr\u00e4umen
      const prev = await getWelcomeConfig(guildId);
      if (prev?.mediaUrl) {
        await deleteMediaIfLocal(prev.mediaUrl);
      }

      let media: string | undefined = mediaUrl;
      if (mediaAttachment) {
        const saved = await saveAttachment(mediaAttachment, 'welcome', guildId, 'banner');
        if (!saved.ok || !saved.localPath) {
          await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription(saved.message)] });
          return;
        }
        media = saved.localPath;
      }

      await setWelcomeConfig(guildId, {
        enabled: true,
        channelId: channel.id,
        message,
        mediaUrl: media,
        mode,
      }, interaction.user.id);

      const mediaDisplay = media
        ? (media.startsWith('http') ? media : `\ud83d\udcce ${media.split('/').pop()} (lokal gespeichert)`)
        : null;
      const embed = vEmbed(Colors.Success)
        .setTitle('\u2705 Welcome-Konfiguration gespeichert')
        .addFields(
          { name: 'Channel', value: `<#${channel.id}>`, inline: true },
          { name: 'Modus', value: mode, inline: true },
          { name: 'Nachricht/Prompt', value: message.slice(0, 1000), inline: false },
          ...(mediaDisplay ? [{ name: 'Media', value: mediaDisplay, inline: false }] : []),
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'show') {
      const cfg = await getWelcomeConfig(guildId);
      if (!cfg) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Info).setDescription('_Keine Welcome-Konfiguration vorhanden._')] });
        return;
      }
      const mediaDisplay = cfg.mediaUrl
        ? (cfg.mediaUrl.startsWith('http') ? cfg.mediaUrl : `\ud83d\udcce ${cfg.mediaUrl.split('/').pop()} (lokal gespeichert)`)
        : null;
      const embed = vEmbed(Colors.Info)
        .setTitle('\ud83d\udc4b Welcome-Konfiguration')
        .addFields(
          { name: 'Aktiv', value: cfg.enabled ? '\u2705' : '\u274c', inline: true },
          { name: 'Channel', value: `<#${cfg.channelId}>`, inline: true },
          { name: 'Modus', value: cfg.mode, inline: true },
          { name: 'Nachricht/Prompt', value: cfg.message.slice(0, 1000), inline: false },
          ...(mediaDisplay ? [{ name: 'Media', value: mediaDisplay, inline: false }] : []),
        );
      await interaction.editReply({ embeds: [embed] });
      return;
    }

    if (sub === 'disable') {
      const prev = await getWelcomeConfig(guildId);
      if (prev?.mediaUrl) await deleteMediaIfLocal(prev.mediaUrl);
      await disableWelcome(guildId, interaction.user.id);
      await interaction.editReply({ embeds: [vEmbed(Colors.Success).setDescription('\u2705 Welcome-System deaktiviert.')] });
      return;
    }

    if (sub === 'test') {
      const cfg = await getWelcomeConfig(guildId);
      if (!cfg || !cfg.enabled) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription('\u274c Kein aktives Welcome konfiguriert.')] });
        return;
      }
      const channel = interaction.guild.channels.cache.get(cfg.channelId) as TextChannel | undefined;
      if (!channel?.isTextBased()) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription('\u274c Channel nicht (mehr) verf\u00fcgbar.')] });
        return;
      }

      const userMention = `<@${interaction.user.id}>`;
      const memberCount = interaction.guild.memberCount;

      let messageText: string;
      if (cfg.mode === 'ai') {
        // Variablen vor dem Einsetzen sanitisieren – verhindert Prompt-Injection
        // über Username/Guildname/Custom-Template.
        const safeUser = sanitizeForPrompt(interaction.user.username, 100);
        const safeGuild = sanitizeForPrompt(interaction.guild.name, 100);
        const safeTemplate = sanitizeForPrompt(cfg.message, 1000);
        const prompt = renderWelcomeMessage(safeTemplate, { user: safeUser, guild: safeGuild, memberCount });
        // 8-Sekunden-Timeout – Fallback auf statischen Text wenn LLM zu langsam.
        const r = await withTimeout(
          answerQuestion(
            `Erzeuge eine kurze, freundliche, einladende Begrüßung. Anweisung: ${prompt}\n\nNutzer: ${safeUser}\nServer: ${safeGuild}\nMitgliederzahl: ${memberCount}\n\nGib NUR den Begrüßungstext zurück (max. 600 Zeichen).`,
            { mode: 'welcome' },
          ),
          8000,
          'welcome.ai',
        );
        messageText = r && r.success && r.result ? `${userMention} ${r.result.trim()}` : `${userMention} Willkommen!`;
      } else {
        messageText = renderWelcomeMessage(cfg.message, { user: userMention, guild: interaction.guild.name, memberCount });
      }

      const files = cfg.mediaUrl ? [new AttachmentBuilder(cfg.mediaUrl)] : undefined;
      try {
        const finalText = resolveCustomEmotes(messageText, interaction.guild);
        await channel.send({ content: finalText.slice(0, 2000), files });
        await interaction.editReply({ embeds: [vEmbed(Colors.Success).setDescription(`\u2705 Test-Begr\u00fc\u00dfung in <#${channel.id}> gesendet.`)] });
      } catch (err) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setDescription(`\u274c Senden fehlgeschlagen: ${String(err).slice(0, 500)}`)] });
      }
      return;
    }
  },
};

export default welcomeCommand;
