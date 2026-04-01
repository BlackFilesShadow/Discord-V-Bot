import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { downloadSingleFile, downloadPackageAsZip } from '../../modules/download/downloadHandler';
import fs from 'fs';

/**
 * /download Command (Sektion 3):
 * - Download von Einzeldateien oder kompletten Paketen
 * - Global für alle Nutzer
 */
const downloadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('download')
    .setDescription('Dateien oder Pakete herunterladen')
    .addStringOption(opt =>
      opt.setName('paketname').setDescription('Name des Pakets').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('datei').setDescription('Optionaler Dateiname für Einzel-Download').setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('format').setDescription('Download-Format')
        .setRequired(false)
        .addChoices(
          { name: 'ZIP', value: 'zip' },
          { name: 'Einzeldatei', value: 'single' },
        )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply();

    const paketname = interaction.options.getString('paketname', true);
    const dateiname = interaction.options.getString('datei');
    const format = interaction.options.getString('format') || 'zip';

    // Paket suchen (global für alle Nutzer)
    const pkg = await prisma.package.findFirst({
      where: { name: { equals: paketname, mode: 'insensitive' }, isDeleted: false },
      include: {
        files: { where: { isDeleted: false, isQuarantined: false } },
        user: { select: { username: true } },
      },
    });

    if (!pkg) {
      await interaction.editReply({ content: `❌ Paket "${paketname}" nicht gefunden.` });
      return;
    }

    if (dateiname || format === 'single') {
      // Einzeldatei-Download
      const fileName = dateiname || '';
      const file = pkg.files.find((f: any) =>
        f.originalName.toLowerCase() === fileName.toLowerCase()
      );

      if (!file) {
        const availableFiles = pkg.files.map((f: any) => `• ${f.originalName}`).join('\n');
        await interaction.editReply({
          content: `❌ Datei "${fileName}" nicht im Paket gefunden.\n\n**Verfügbare Dateien:**\n${availableFiles}`,
        });
        return;
      }

      const result = await downloadSingleFile(file.id, interaction.user.id);
      if (!result.success || !result.filePath) {
        await interaction.editReply({ content: `❌ ${result.message}` });
        return;
      }

      const attachment = new AttachmentBuilder(result.filePath, {
        name: result.fileName || file.originalName,
      });

      const embed = new EmbedBuilder()
        .setTitle('📥 Download')
        .setDescription(`Datei: **${file.originalName}**\nPaket: **${pkg.name}** von **${pkg.user.username}**`)
        .setColor(0x00ff00)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    } else {
      // Paket-Download (ZIP)
      const result = await downloadPackageAsZip(pkg.id, interaction.user.id);
      if (!result.success || !result.zipBuffer) {
        await interaction.editReply({ content: `❌ ${result.message}` });
        return;
      }

      const attachment = new AttachmentBuilder(result.zipBuffer, {
        name: result.fileName || `${pkg.name}.zip`,
      });

      const embed = new EmbedBuilder()
        .setTitle('📥 Paket-Download')
        .setDescription(`Paket: **${pkg.name}** von **${pkg.user.username}**`)
        .addFields(
          { name: '📄 Dateien', value: pkg.files.length.toString(), inline: true },
          { name: '📊 Format', value: 'ZIP', inline: true },
        )
        .setColor(0x00ff00)
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], files: [attachment] });
    }
  },
};

export default downloadCommand;
