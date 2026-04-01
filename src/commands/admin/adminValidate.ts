import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { validateFile } from '../../utils/validator';
import { logAudit } from '../../utils/logger';
import fs from 'fs';

/**
 * /admin-validate [paket|datei] — Manuelle (Re-)Validierung, Fehleranalyse, Quarantäne.
 * Sektion 2: Hochmoderner XML- & JSON-Validator.
 */
const adminValidateCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('admin-validate')
    .setDescription('Pakete oder Dateien manuell (re-)validieren')
    .addSubcommand(sub =>
      sub
        .setName('paket')
        .setDescription('Ganzes Paket validieren')
        .addStringOption(opt =>
          opt.setName('paket-id').setDescription('Paket-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('datei')
        .setDescription('Einzelne Datei validieren')
        .addStringOption(opt =>
          opt.setName('datei-id').setDescription('Datei-Upload-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('quarantaene')
        .setDescription('Paket in Quarantäne setzen oder freigeben')
        .addStringOption(opt =>
          opt.setName('paket-id').setDescription('Paket-ID').setRequired(true)
        )
        .addBooleanOption(opt =>
          opt.setName('freigeben').setDescription('Quarantäne aufheben?').setRequired(false)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    switch (sub) {
      case 'paket': {
        const paketId = interaction.options.getString('paket-id', true);
        const pkg = await prisma.package.findUnique({
          where: { id: paketId },
          include: { files: true },
        });

        if (!pkg) {
          await interaction.editReply({ content: '❌ Paket nicht gefunden.' });
          return;
        }

        const results: string[] = [];
        let validCount = 0;
        let invalidCount = 0;

        for (const file of pkg.files) {
          if (!fs.existsSync(file.filePath)) {
            results.push(`❌ **${file.originalName}**: Datei nicht gefunden`);
            invalidCount++;
            continue;
          }

          const validation = await validateFile(file.filePath);

          await prisma.upload.update({
            where: { id: file.id },
            data: {
              isValid: validation.isValid,
              validationStatus: validation.isValid ? 'VALID' : 'INVALID',
            },
          });

          await prisma.validationResult.create({
            data: {
              uploadId: file.id,
              packageId: pkg.id,
              isValid: validation.isValid,
              errors: JSON.parse(JSON.stringify(validation.errors)),
              warnings: JSON.parse(JSON.stringify(validation.warnings)),
              suggestions: JSON.parse(JSON.stringify(validation.suggestions)),
              validatedBy: interaction.user.id,
            },
          });

          if (validation.isValid) {
            validCount++;
            results.push(`✅ **${file.originalName}**: Valide`);
          } else {
            invalidCount++;
            results.push(`❌ **${file.originalName}**: ${validation.errors.length} Fehler`);
          }
        }

        logAudit('PACKAGE_REVALIDATED', 'ADMIN', {
          packageId: paketId, adminId: interaction.user.id, validCount, invalidCount,
        });

        const embed = new EmbedBuilder()
          .setTitle(`🔍 Validierung: ${pkg.name}`)
          .setDescription(results.join('\n'))
          .setColor(invalidCount === 0 ? 0x00ff00 : 0xff0000)
          .addFields(
            { name: '✅ Valide', value: `${validCount}`, inline: true },
            { name: '❌ Invalide', value: `${invalidCount}`, inline: true },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'datei': {
        const dateiId = interaction.options.getString('datei-id', true);
        const upload = await prisma.upload.findUnique({ where: { id: dateiId } });

        if (!upload) {
          await interaction.editReply({ content: '❌ Datei nicht gefunden.' });
          return;
        }

        if (!fs.existsSync(upload.filePath)) {
          await interaction.editReply({ content: '❌ Datei auf dem Server nicht gefunden.' });
          return;
        }

        const validation = await validateFile(upload.filePath);

        await prisma.upload.update({
          where: { id: dateiId },
          data: {
            isValid: validation.isValid,
            validationStatus: validation.isValid ? 'VALID' : 'INVALID',
          },
        });

        const embed = new EmbedBuilder()
          .setTitle(`🔍 Validierung: ${upload.originalName}`)
          .setColor(validation.isValid ? 0x00ff00 : 0xff0000)
          .addFields(
            { name: 'Status', value: validation.isValid ? '✅ Valide' : '❌ Invalide' },
            { name: 'Fehler', value: validation.errors.length > 0 ? validation.errors.map(e => e.message).join('\n') : 'Keine' },
            { name: 'Warnungen', value: validation.warnings.length > 0 ? validation.warnings.map(w => w.message).join('\n') : 'Keine' },
            { name: 'Vorschläge', value: validation.suggestions.length > 0 ? validation.suggestions.map(s => s.message).join('\n') : 'Keine' },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'quarantaene': {
        const paketId = interaction.options.getString('paket-id', true);
        const freigeben = interaction.options.getBoolean('freigeben') || false;

        const pkg = await prisma.package.findUnique({ where: { id: paketId } });
        if (!pkg) {
          await interaction.editReply({ content: '❌ Paket nicht gefunden.' });
          return;
        }

        if (freigeben) {
          await prisma.package.update({
            where: { id: paketId },
            data: { status: 'ACTIVE' },
          });
          logAudit('PACKAGE_RELEASED_FROM_QUARANTINE', 'ADMIN', {
            packageId: paketId, adminId: interaction.user.id,
          });
          await interaction.editReply({ content: `✅ Paket **${pkg.name}** aus Quarantäne freigegeben.` });
        } else {
          await prisma.package.update({
            where: { id: paketId },
            data: { status: 'QUARANTINED' },
          });
          logAudit('PACKAGE_QUARANTINED', 'ADMIN', {
            packageId: paketId, adminId: interaction.user.id,
          });
          await interaction.editReply({ content: `⚠️ Paket **${pkg.name}** in Quarantäne gesetzt.` });
        }
        break;
      }
    }
  },
};

export default adminValidateCommand;
