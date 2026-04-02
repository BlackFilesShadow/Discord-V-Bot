import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AttachmentBuilder,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { checkUploadPermission, getOrCreatePackage, processUpload } from '../../modules/upload/uploadHandler';
import axios from 'axios';
import { Colors, Brand, vEmbed, formatBytes } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';

/**
 * /upload Command (Sektion 2):
 * - Upload von Dateien in eigenen GUID-Bereich
 * - Paketname + Datei direkt angeben
 * - XML/JSON Validierung mit detailliertem Feedback
 * - Format wird automatisch aus dem Dateinamen erkannt
 */
const builder = new SlashCommandBuilder()
  .setName('upload')
  .setDescription('Dateien in ein Paket hochladen (bis zu 10 Dateien)')
  .addStringOption(opt =>
    opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)
  )
  .addAttachmentOption(opt =>
    opt.setName('datei').setDescription('Datei 1 (XML/JSON, max 2 GB)').setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('beschreibung').setDescription('Optionale Beschreibung des Pakets').setRequired(false)
  );

// Datei 2–10 als optionale Attachments
for (let i = 2; i <= 10; i++) {
  builder.addAttachmentOption(opt =>
    opt.setName(`datei${i}`).setDescription(`Datei ${i} (optional)`).setRequired(false)
  );
}

const uploadCommand: Command = {
  data: builder,

  execute: async (interaction: ChatInputCommandInteraction) => {
    const paketname = interaction.options.getString('paketname', true);

    // Alle angehängten Dateien sammeln (1–10)
    const attachments: { url: string; name: string | null; contentType: string | null }[] = [];
    const first = interaction.options.getAttachment('datei', true);
    attachments.push(first);
    for (let i = 2; i <= 10; i++) {
      const att = interaction.options.getAttachment(`datei${i}`);
      if (att) attachments.push(att);
    }

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

    // Direkt hochladen — kein Dropdown nötig, Format wird automatisch erkannt
    await interaction.deferReply({ ephemeral: true });

    const beschreibung = interaction.options.getString('beschreibung') || undefined;

    // Alle Dateien nacheinander in dasselbe Paket uploaden
    const results: { name: string; success: boolean; embed: EmbedBuilder }[] = [];
    for (const att of attachments) {
      const result = await processAndReply(interaction, dbUser, paketname, att, beschreibung, attachments.length > 1);
      results.push(result);
    }

    // Zusammenfassungs-Embed bei mehreren Dateien
    if (attachments.length > 1) {
      const successCount = results.filter(r => r.success).length;
      const failCount = results.length - successCount;
      const summaryEmbed = vEmbed(failCount === 0 ? Colors.Success : Colors.Warning)
        .setTitle(`📦  Upload: ${paketname}`)
        .setDescription(
          `${Brand.divider}\n\n` +
          `**${successCount}/${results.length}** Dateien erfolgreich hochgeladen.` +
          (failCount > 0 ? `\n❌ ${failCount} fehlgeschlagen.` : '') +
          `\n\n${Brand.divider}`
        );

      for (const r of results) {
        summaryEmbed.addFields({
          name: `${r.success ? '✅' : '❌'} ${r.name}`,
          value: r.success ? 'Erfolgreich' : 'Fehlgeschlagen',
          inline: true,
        });
      }

      await interaction.editReply({ embeds: [summaryEmbed] });
    }
  },
};

/**
 * Verarbeitet den Upload und antwortet mit Feedback.
 */
async function processAndReply(
  interaction: ChatInputCommandInteraction,
  dbUser: { id: string; username: string },
  paketname: string,
  attachment: { url: string; name: string | null; contentType: string | null },
  beschreibung?: string,
  isMulti?: boolean,
): Promise<{ name: string; success: boolean; embed: EmbedBuilder }> {
  // Paket erstellen/finden (GUID-gebunden)
  const pkg = await getOrCreatePackage(dbUser.id, paketname, beschreibung);
  const fileName = attachment.name || 'unknown';

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
      fileName,
      attachment.contentType || 'application/octet-stream'
    );

    const embed = vEmbed(result.success ? Colors.Upload : Colors.Error)
      .setTitle(result.success ? '✅  Upload erfolgreich' : '❌  Upload fehlgeschlagen');

    if (result.success) {
      embed.addFields(
        { name: '📦 Paket', value: paketname, inline: true },
        { name: '📄 Datei', value: fileName, inline: true },
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

    // Bei Einzel-Upload direkt antworten, bei Multi kommt Zusammenfassung
    if (!isMulti) {
      await interaction.editReply({ embeds: [embed] });
    }
    return { name: fileName, success: result.success, embed };
  } catch (error) {
    const embed = createBotEmbed({
      title: '❌ Upload fehlgeschlagen',
      description: `Fehler beim Download der Datei: ${error instanceof Error ? error.message : 'Unbekannter Fehler'}`,
      color: Colors.Error,
      footer: `${Brand.footerText} • Upload`,
      timestamp: true,
    });
    if (!isMulti) {
      await interaction.editReply({ embeds: [embed] });
    }
    return { name: fileName, success: false, embed };
  }
}

export default uploadCommand;
