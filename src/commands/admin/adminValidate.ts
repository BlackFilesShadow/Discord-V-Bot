import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { validateFile } from '../../utils/validator';
import { logAudit, logger } from '../../utils/logger';
import { withTimeout } from '../../utils/safeSend';
import fs from 'fs';

const MAX_VALIDATE_BYTES = 50 * 1024 * 1024; // 50 MB
const VALIDATE_TIMEOUT_MS = 30_000;

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

          let stat: fs.Stats;
          try {
            stat = fs.statSync(file.filePath);
          } catch (e) {
            results.push(`❌ **${file.originalName}**: stat fehlgeschlagen`);
            invalidCount++;
            logger.warn(`adminValidate stat ${file.id}: ${(e as Error).message}`);
            continue;
          }
          if (stat.size > MAX_VALIDATE_BYTES) {
            results.push(`⚠️ **${file.originalName}**: übersprungen (>50 MB)`);
            invalidCount++;
            continue;
          }

          let validation: Awaited<ReturnType<typeof validateFile>>;
          try {
            const v = await withTimeout(validateFile(file.filePath), VALIDATE_TIMEOUT_MS, `validateFile:${file.id}`);
            if (v === null) throw new Error('Timeout');
            validation = v;
          } catch (e) {
            results.push(`❌ **${file.originalName}**: Validator-Fehler/Timeout`);
            invalidCount++;
            logger.error(`adminValidate validateFile ${file.id} fehlgeschlagen:`, e as Error);
            continue;
          }

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

        const stat = fs.statSync(upload.filePath);
        if (stat.size > MAX_VALIDATE_BYTES) {
          await interaction.editReply({ content: '⚠️ Datei zu groß (>50 MB) für On-Demand-Validierung.' });
          return;
        }

        let validation: Awaited<ReturnType<typeof validateFile>>;
        try {
          const v = await withTimeout(validateFile(upload.filePath), VALIDATE_TIMEOUT_MS, `validateFile:${dateiId}`);
          if (v === null) throw new Error('Timeout');
          validation = v;
        } catch (e) {
          logger.error(`adminValidate datei ${dateiId} fehlgeschlagen:`, e as Error);
          await interaction.editReply({ content: `❌ Validator-Fehler: ${String((e as Error)?.message ?? e).slice(0, 500)}` });
          return;
        }

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
