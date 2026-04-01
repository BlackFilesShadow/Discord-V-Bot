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
import { downloadSingleFile, downloadPackageAsZip } from '../../modules/download/downloadHandler';
import fs from 'fs';

/**
 * /download Command (Sektion 3):
 * - Dropdown-Menü: Hersteller → Paket → Format
 * - Download von Einzeldateien oder kompletten Paketen
 * - Global für alle Nutzer
 */
const downloadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('download')
    .setDescription('Dateien oder Pakete herunterladen')
    .addStringOption(opt =>
      opt.setName('paketname').setDescription('Name des Pakets (leer = Dropdown-Menü)').setRequired(false)
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
    const paketname = interaction.options.getString('paketname');
    const dateiname = interaction.options.getString('datei');
    const format = interaction.options.getString('format') || 'zip';

    // Ohne Paketname: Dropdown-Menü mit allen verfügbaren Herstellern/Paketen
    if (!paketname) {
      await showDownloadMenu(interaction);
      return;
    }

    await interaction.deferReply();

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

    await handlePackageDownload(interaction, pkg, dateiname, format);
  },
};

/**
 * Zeigt das Download-Dropdown-Menü mit Herstellern und Paketen.
 */
async function showDownloadMenu(interaction: ChatInputCommandInteraction): Promise<void> {
  // Alle verfügbaren Pakete mit Hersteller laden
  const packages = await prisma.package.findMany({
    where: { isDeleted: false },
    include: {
      user: { select: { username: true } },
      _count: { select: { files: true } },
    },
    take: 25,
    orderBy: { createdAt: 'desc' },
  });

  if (packages.length === 0) {
    await interaction.reply({
      content: '📭 Keine Pakete zum Download verfügbar.',
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('📥 Download-Bereich')
    .setDescription(
      `**${packages.length} Pakete verfügbar**\n\n` +
      `Wähle ein Paket aus dem Dropdown-Menü unten zum Herunterladen.`
    )
    .setColor(0x0099ff)
    .setTimestamp();

  const packageSelect = new StringSelectMenuBuilder()
    .setCustomId('download_package_select')
    .setPlaceholder('📦 Paket auswählen...')
    .addOptions(
      packages.map(pkg =>
        new StringSelectMenuOptionBuilder()
          .setLabel(pkg.name)
          .setDescription(`von ${pkg.user.username} · ${pkg._count.files} Datei(en)`)
          .setValue(pkg.id)
          .setEmoji('📦')
      )
    );

  const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(packageSelect);

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
    const selectedPkgId = menuInteraction.values[0];

    // Paket-Daten laden
    const pkg = await prisma.package.findUnique({
      where: { id: selectedPkgId },
      include: {
        files: { where: { isDeleted: false, isQuarantined: false } },
        user: { select: { username: true } },
      },
    });

    if (!pkg || pkg.files.length === 0) {
      await menuInteraction.update({
        embeds: [new EmbedBuilder().setTitle('❌ Keine Dateien').setDescription('Dieses Paket enthält keine Dateien.').setColor(0xff0000)],
        components: [],
      });
      return;
    }

    // Format-Auswahl anzeigen
    const formatSelect = new StringSelectMenuBuilder()
      .setCustomId('download_format_select')
      .setPlaceholder('📂 Format / Datei auswählen...')
      .addOptions(
        new StringSelectMenuOptionBuilder()
          .setLabel(`Komplettes Paket (ZIP)`)
          .setDescription(`Alle ${pkg.files.length} Dateien als ZIP herunterladen`)
          .setValue(`zip_${pkg.id}`)
          .setEmoji('📦'),
        ...pkg.files.slice(0, 24).map((file: any) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(file.originalName)
            .setDescription(`Einzelne Datei herunterladen`)
            .setValue(`file_${file.id}`)
            .setEmoji('📄')
        ),
      );

    const formatRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(formatSelect);

    const detailEmbed = new EmbedBuilder()
      .setTitle(`📦 ${pkg.name}`)
      .setDescription(
        `**Hersteller:** ${pkg.user.username}\n` +
        `**Dateien:** ${pkg.files.length}\n\n` +
        `Wähle eine einzelne Datei oder das komplette Paket als ZIP.`
      )
      .setColor(0x0099ff)
      .setTimestamp();

    // Neuen Collector auf der neuen Nachricht erstellen
    const updateResponse = await menuInteraction.update({ embeds: [detailEmbed], components: [formatRow] });

    const formatCollector = updateResponse.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 120_000,
    });

    formatCollector.on('collect', async (formatMenuInteraction) => {
      const val = formatMenuInteraction.values[0];

      await formatMenuInteraction.update({
        embeds: [new EmbedBuilder().setTitle('⏳ Download wird vorbereitet...').setColor(0xffaa00)],
        components: [],
      });

      try {
        if (val.startsWith('zip_')) {
          const result = await downloadPackageAsZip(pkg.id, interaction.user.id);
          if (!result.success || !result.zipBuffer) {
            await interaction.editReply({ content: `❌ ${result.message}`, embeds: [], components: [] });
            return;
          }

          const attachment = new AttachmentBuilder(result.zipBuffer, {
            name: result.fileName || `${pkg.name}.zip`,
          });

          const doneEmbed = new EmbedBuilder()
            .setTitle('📥 Paket-Download')
            .setDescription(`**${pkg.name}** von **${pkg.user.username}**`)
            .addFields(
              { name: '📄 Dateien', value: pkg.files.length.toString(), inline: true },
              { name: '📊 Format', value: 'ZIP', inline: true },
            )
            .setColor(0x00ff00)
            .setTimestamp();

          await interaction.editReply({ embeds: [doneEmbed], files: [attachment], components: [] });
        } else if (val.startsWith('file_')) {
          const fileId = val.replace('file_', '');
          const result = await downloadSingleFile(fileId, interaction.user.id);
          const file = pkg.files.find((f: any) => f.id === fileId);

          if (!result.success || !result.filePath) {
            await interaction.editReply({ content: `❌ ${result.message}`, embeds: [], components: [] });
            return;
          }

          const attachment = new AttachmentBuilder(result.filePath, {
            name: result.fileName || file?.originalName || 'download',
          });

          const doneEmbed = new EmbedBuilder()
            .setTitle('📥 Datei-Download')
            .setDescription(`**${file?.originalName || 'Datei'}** aus **${pkg.name}**`)
            .setColor(0x00ff00)
            .setTimestamp();

          await interaction.editReply({ embeds: [doneEmbed], files: [attachment], components: [] });
        }
      } catch (error) {
        await interaction.editReply({ content: '❌ Download fehlgeschlagen.', embeds: [], components: [] });
      }
    });
  });

  collector.on('end', async (_, reason) => {
    if (reason === 'time') {
      try { await interaction.editReply({ components: [] }); } catch {}
    }
  });
}

/**
 * Verarbeitet den Download eines Pakets (direkt per Slash-Command-Argumente).
 */
async function handlePackageDownload(
  interaction: ChatInputCommandInteraction,
  pkg: any,
  dateiname: string | null,
  format: string,
): Promise<void> {

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
}

export default downloadCommand;
