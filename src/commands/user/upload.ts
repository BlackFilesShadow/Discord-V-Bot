import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  Attachment,
  MessageFlags,
} from 'discord.js';
import axios from 'axios';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import {
  checkUploadPermission,
  getOrCreatePackage,
  processUpload,
  DuplicatePackageNameError,
} from '../../modules/upload/uploadHandler';
import { config } from '../../config';
import { Colors, Brand, vEmbed, formatBytes } from '../../utils/embedDesign';

/**
 * /upload (Sektion 2):
 * - Bis zu 10 Dateien pro Aufruf in dasselbe Paket
 * - Vor dem Download wird die Discord-Attachment-Groesse gegen das konfigurierte
 *   Maximum geprueft → kein 2 GB-Memory-Spike mehr
 * - Multi-File-Loop sammelt ALLE Resultate (auch bei Teilfehlern) und liefert
 *   eine Zusammenfassung statt frueh abzubrechen.
 */
const MAX_FILES = 10;

const builder = new SlashCommandBuilder()
  .setName('upload')
  .setDescription('Dateien in ein Paket hochladen (bis zu 10 Dateien)')
  .addStringOption(opt =>
    opt.setName('paketname').setDescription('Name des Pakets').setRequired(true).setMaxLength(120)
  )
  .addAttachmentOption(opt =>
    opt.setName('datei').setDescription('Datei 1 (XML/JSON)').setRequired(true)
  )
  .addStringOption(opt =>
    opt.setName('beschreibung').setDescription('Optionale Beschreibung des Pakets').setRequired(false).setMaxLength(500)
  );

for (let i = 2; i <= MAX_FILES; i++) {
  builder.addAttachmentOption(opt =>
    opt.setName(`datei${i}`).setDescription(`Datei ${i} (optional)`).setRequired(false)
  );
}

interface FileResult {
  name: string;
  success: boolean;
  message: string;
}

const uploadCommand: Command = {
  data: builder,
  manufacturerOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    const paketname = interaction.options.getString('paketname', true);

    const attachments: Attachment[] = [];
    attachments.push(interaction.options.getAttachment('datei', true));
    for (let i = 2; i <= MAX_FILES; i++) {
      const att = interaction.options.getAttachment(`datei${i}`);
      if (att) attachments.push(att);
    }

    // User aus DB holen oder leise anlegen.
    let dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
    if (!dbUser) {
      dbUser = await prisma.user.create({
        data: { discordId: interaction.user.id, username: interaction.user.username },
      });
    }

    // Hersteller-Permission pruefen.
    const permission = await checkUploadPermission(dbUser.id);
    if (!permission.allowed) {
      let extra = '';
      try {
        const req = await prisma.manufacturerRequest.findUnique({ where: { userId: dbUser.id } });
        if (req?.status === 'PENDING') {
          extra = '\n⏳ Deine Hersteller-Anfrage ist **noch nicht angenommen**.';
        } else if (req?.status === 'APPROVED' && dbUser.status !== 'ACTIVE') {
          extra = '\n🔑 Anfrage angenommen, aber Account noch nicht aktiv. Verwende `/register verify password:DEIN_OTP`.';
        } else if (req?.status === 'DENIED') {
          extra = '\n❌ Letzte Hersteller-Anfrage wurde abgelehnt.';
        }
      } catch { /* DB optional */ }
      await interaction.reply({ content: `❌ ${permission.reason}${extra}`, flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const beschreibung = interaction.options.getString('beschreibung') || undefined;

    // Paket einmalig anlegen.
    let pkg;
    try {
      pkg = await getOrCreatePackage(dbUser.id, paketname, beschreibung);
    } catch (e) {
      if (e instanceof DuplicatePackageNameError) {
        await interaction.editReply({
          embeds: [
            vEmbed(Colors.Error)
              .setTitle('❌ Doppelter Paketname')
              .setDescription(
                `${e.message}\n\nWaehle einen anderen Namen oder loesche das vorhandene Paket zuerst mit ` +
                `\`/mypackages delete paketname:${paketname}\`.`,
              ),
          ],
        });
        return;
      }
      throw e;
    }

    // Pre-Check Groessen (vermeidet Download grosser Attachments, die ohnehin
    // am Maximum scheitern wuerden).
    const maxBytes = config.upload.maxFileSizeBytes;
    const results: FileResult[] = [];

    for (const att of attachments) {
      const fileName = att.name || 'unknown';
      const declaredSize = att.size ?? 0;
      if (declaredSize > maxBytes) {
        results.push({
          name: fileName,
          success: false,
          message: `Zu gross: ${formatBytes(declaredSize)} > ${formatBytes(maxBytes)}`,
        });
        continue;
      }

      try {
        const response = await axios.get<ArrayBuffer>(att.url, {
          responseType: 'arraybuffer',
          maxContentLength: maxBytes,
          maxBodyLength: maxBytes,
          timeout: 120_000,
        });
        const fileBuffer = Buffer.from(response.data);

        const result = await processUpload(
          dbUser.id,
          pkg.id,
          fileBuffer,
          fileName,
          att.contentType || 'application/octet-stream',
        );
        results.push({
          name: fileName,
          success: result.success,
          message: result.message,
        });
      } catch (error) {
        results.push({
          name: fileName,
          success: false,
          message: error instanceof Error ? error.message : 'Unbekannter Fehler',
        });
      }
    }

    // Zusammenfassung — IMMER, auch bei Teilfehlern.
    const okCount = results.filter(r => r.success).length;
    const failCount = results.length - okCount;
    const color = failCount === 0 ? Colors.Success : okCount === 0 ? Colors.Error : Colors.Warning;

    const summary = vEmbed(color)
      .setTitle(`📦 Upload: ${paketname}`)
      .setDescription(
        `${Brand.divider}\n\n` +
        `**${okCount}/${results.length}** Dateien erfolgreich.` +
        (failCount > 0 ? `\n❌ ${failCount} fehlgeschlagen.` : '') +
        `\n\n${Brand.divider}`,
      );

    const fields: { name: string; value: string; inline: boolean }[] = [];
    for (const r of results.slice(0, 25)) {
      fields.push({
        name: `${r.success ? '✅' : '❌'} ${r.name}`.slice(0, 256),
        value: r.message.slice(0, 1024),
        inline: false,
      });
    }
    if (fields.length) summary.addFields(fields);

    await interaction.editReply({ embeds: [summary] });
  },
};

export default uploadCommand;
