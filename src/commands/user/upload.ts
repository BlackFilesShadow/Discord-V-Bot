import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { checkUploadPermission, getOrCreatePackage, processUpload } from '../../modules/upload/uploadHandler';
import axios from 'axios';

/**
 * /upload Command (Sektion 2):
 * - Upload von Dateien in eigenen GUID-Bereich
 * - Dropdown-Menü: Hersteller-Name → Format (JSON/XML/Paket)
 * - XML/JSON Validierung mit detailliertem Feedback
 */
const uploadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('upload')
    .setDescription('Datei in ein Paket hochladen')
    .addStringOption(opt =>
      opt.setName('paketname').setDescription('Name des Pakets').setRequired(false)
    )
    .addAttachmentOption(opt =>
      opt.setName('datei').setDescription('Die zu uploadende Datei (XML/JSON, max 2 GB)').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('beschreibung').setDescription('Optionale Beschreibung des Pakets').setRequired(false)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const paketname = interaction.options.getString('paketname');
    const attachment = interaction.options.getAttachment('datei');

    // User aus DB holen
    const dbUser = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!dbUser) {
      await interaction.reply({ content: '❌ Du bist nicht registriert. Verwende `/register manufacturer`.', ephemeral: true });
      return;
    }

    // Uploadrechte prüfen (Sektion 1: nur eigener GUID-Bereich)
    const permission = await checkUploadPermission(dbUser.id);
    if (!permission.allowed) {
      await interaction.reply({ content: `❌ ${permission.reason}`, ephemeral: true });
      return;
    }

    // Ohne Argumente: Dropdown-Menü anzeigen
    if (!paketname || !attachment) {
      await showUploadMenu(interaction, dbUser);
      return;
    }

    // Mit Argumenten: Direkt hochladen
    await interaction.deferReply({ ephemeral: true });

    const beschreibung = interaction.options.getString('beschreibung') || undefined;
    await processAndReply(interaction, dbUser, paketname, attachment, beschreibung);
  },
};

/**
 * Zeigt das Hersteller-Upload-Dropdown-Menü an.
 */
async function showUploadMenu(
  interaction: ChatInputCommandInteraction,
  dbUser: { id: string; username: string; guid?: string | null },
): Promise<void> {
  // Vorhandene Pakete des Users laden
  const userPackages = await prisma.package.findMany({
    where: { userId: dbUser.id, isDeleted: false },
    select: { name: true },
    take: 20,
  });

  const embed = new EmbedBuilder()
    .setTitle(`📤 Upload-Bereich — ${dbUser.username}`)
    .setDescription(
      `Willkommen im Upload-Bereich!\n\n` +
      `**Wähle das Format** aus dem Dropdown-Menü unten.\n` +
      `Anschließend verwende:\n` +
      `\`/upload <paketname> <datei>\`\n\n` +
      (userPackages.length > 0
        ? `**Deine Pakete:** ${userPackages.map(p => `\`${p.name}\``).join(', ')}`
        : '📦 Du hast noch keine Pakete.')
    )
    .setColor(0x0099ff)
    .setTimestamp();

  const formatSelect = new StringSelectMenuBuilder()
    .setCustomId('upload_format_select')
    .setPlaceholder('📂 Format auswählen...')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('JSON-Datei')
        .setDescription('Eine einzelne JSON-Datei hochladen')
        .setValue('json')
        .setEmoji('📄'),
      new StringSelectMenuOptionBuilder()
        .setLabel('XML-Datei')
        .setDescription('Eine einzelne XML-Datei hochladen')
        .setValue('xml')
        .setEmoji('📋'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Paket (mehrere Dateien)')
        .setDescription('Ein Paket mit mehreren Dateien hochladen')
        .setValue('paket')
        .setEmoji('📦'),
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(formatSelect);

  const response = await interaction.reply({
    embeds: [embed],
    components: [row],
    ephemeral: true,
  });

  const collector = response.createMessageComponentCollector({
    componentType: ComponentType.StringSelect,
    time: 120_000,
  });

  collector.on('collect', async (menuInteraction) => {
    const selected = menuInteraction.values[0];
    const formatLabels: Record<string, string> = {
      json: 'JSON-Datei (.json)',
      xml: 'XML-Datei (.xml)',
      paket: 'Paket (mehrere Dateien)',
    };

    const instructionEmbed = new EmbedBuilder()
      .setTitle(`📤 Upload — ${formatLabels[selected]}`)
      .setDescription(
        `**Format:** ${formatLabels[selected]}\n\n` +
        `Verwende jetzt folgenden Command:\n\n` +
        `\`/upload <paketname> <datei>\`\n\n` +
        `Ziehe deine ${selected === 'paket' ? 'Dateien' : selected.toUpperCase() + '-Datei'} ` +
        `in das Datei-Feld. Die Validierung erfolgt automatisch.`
      )
      .setColor(0x00ff00)
      .setTimestamp();

    await menuInteraction.update({ embeds: [instructionEmbed], components: [] });
  });

  collector.on('end', async (_, reason) => {
    if (reason === 'time') {
      try { await interaction.editReply({ components: [] }); } catch {}
    }
  });
}

/**
 * Verarbeitet den Upload und antwortet mit Feedback.
 */
async function processAndReply(
  interaction: ChatInputCommandInteraction,
  dbUser: { id: string; username: string },
  paketname: string,
  attachment: { url: string; name: string | null; contentType: string | null },
  beschreibung?: string,
): Promise<void> {
  // Paket erstellen/finden (GUID-gebunden)
  const pkg = await getOrCreatePackage(dbUser.id, paketname, beschreibung);

  try {
    const response = await axios.get(attachment.url, {
      responseType: 'arraybuffer',
      maxContentLength: 2 * 1024 * 1024 * 1024, // 2 GB
    });

    const fileBuffer = Buffer.from(response.data);

    const result = await processUpload(
      dbUser.id,
      pkg.id,
      fileBuffer,
      attachment.name || 'unknown',
      attachment.contentType || 'application/octet-stream'
    );

    const embed = new EmbedBuilder()
      .setTitle(result.success ? '✅ Upload erfolgreich' : '❌ Upload fehlgeschlagen')
      .setColor(result.success ? 0x00ff00 : 0xff0000)
      .setTimestamp();

    if (result.success) {
      embed.addFields(
        { name: '📦 Paket', value: paketname, inline: true },
        { name: '📄 Datei', value: attachment.name || 'unknown', inline: true },
        { name: '📊 Größe', value: formatBytes(fileBuffer.length), inline: true },
      );

      if (result.validation) {
        const v = result.validation;
        embed.addFields(
          { name: '✔️ Validierung', value: v.isValid ? '✅ Gültig' : '❌ Ungültig', inline: true },
          { name: '📝 Dateityp', value: v.fileType.toUpperCase(), inline: true },
        );

        if (v.errors.length > 0) {
          const errorList = v.errors.slice(0, 5).map(e =>
            `• ${e.message}${e.line ? ` (Zeile ${e.line})` : ''}`
          ).join('\n');
          embed.addFields({ name: '❌ Fehler', value: errorList, inline: false });
        }

        if (v.warnings.length > 0) {
          const warnList = v.warnings.slice(0, 5).map(w =>
            `• ${w.message}`
          ).join('\n');
          embed.addFields({ name: '⚠️ Warnungen', value: warnList, inline: false });
        }

        if (v.suggestions.length > 0) {
          const sugList = v.suggestions.slice(0, 3).map(s =>
            `• ${s.message}${s.fix ? ` → ${s.fix}` : ''}`
          ).join('\n');
          embed.addFields({ name: '💡 Vorschläge', value: sugList, inline: false });
        }
      }
    } else {
      embed.setDescription(result.message);
    }

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    await interaction.editReply({
      content: `❌ Fehler beim Download der Datei: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`,
    });
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export default uploadCommand;
