import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { checkUploadPermission, getOrCreatePackage, processUpload } from '../../modules/upload/uploadHandler';
import axios from 'axios';

/**
 * /upload Command (Sektion 2):
 * - Upload von Dateien in eigenen GUID-Bereich
 * - Paketname frei wählbar
 * - XML/JSON Validierung mit detailliertem Feedback
 */
const uploadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('upload')
    .setDescription('Datei in ein Paket hochladen')
    .addStringOption(opt =>
      opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)
    )
    .addAttachmentOption(opt =>
      opt.setName('datei').setDescription('Die zu uploadende Datei (XML/JSON, max 2 GB)').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('beschreibung').setDescription('Optionale Beschreibung des Pakets').setRequired(false)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    // User aus DB holen
    const dbUser = await prisma.user.findUnique({
      where: { discordId: interaction.user.id },
    });

    if (!dbUser) {
      await interaction.editReply({ content: '❌ Du bist nicht registriert. Verwende `/register manufacturer`.' });
      return;
    }

    // Uploadrechte prüfen (Sektion 1: nur eigener GUID-Bereich)
    const permission = await checkUploadPermission(dbUser.id);
    if (!permission.allowed) {
      await interaction.editReply({ content: `❌ ${permission.reason}` });
      return;
    }

    const paketname = interaction.options.getString('paketname', true);
    const attachment = interaction.options.getAttachment('datei', true);
    const beschreibung = interaction.options.getString('beschreibung') || undefined;

    // Paket erstellen/finden (GUID-gebunden)
    const pkg = await getOrCreatePackage(dbUser.id, paketname, beschreibung);

    // Datei von Discord herunterladen
    try {
      const response = await axios.get(attachment.url, {
        responseType: 'arraybuffer',
        maxContentLength: 2 * 1024 * 1024 * 1024, // 2 GB
      });

      const fileBuffer = Buffer.from(response.data);

      // Upload verarbeiten (Validierung, Integritätsprüfung, Speichern)
      const result = await processUpload(
        dbUser.id,
        pkg.id,
        fileBuffer,
        attachment.name || 'unknown',
        attachment.contentType || 'application/octet-stream'
      );

      // Feedback-Embed erstellen (Sektion 2: detaillierte Fehler, Erfolg, Vorschläge)
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
  },
};

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export default uploadCommand;
