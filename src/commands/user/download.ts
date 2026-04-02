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
import { downloadSingleFile } from '../../modules/download/downloadHandler';
import { Colors, Brand, vEmbed, formatBytes } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';

/**
 * /download Command (Sektion 3):
 * Zweistufiges Dropdown-Menü:
 *   1. Hersteller auswählen (zeigt alle Hersteller mit Username)
 *   2. Paket oder Einzeldatei auswählen
 *   3. Datei wird exakt wie hochgeladen bereitgestellt
 */
const downloadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('download')
    .setDescription('Dateien oder Pakete von Herstellern herunterladen'),

  execute: async (interaction: ChatInputCommandInteraction) => {
    // Alle Hersteller laden die mindestens 1 aktives Paket mit Dateien haben
    const manufacturers = await prisma.user.findMany({
      where: {
        isManufacturer: true,
        packages: {
          some: {
            isDeleted: false,
            files: { some: { isDeleted: false, isQuarantined: false } },
          },
        },
      },
      select: {
        id: true,
        username: true,
        discordId: true,
        _count: {
          select: {
            packages: { where: { isDeleted: false } },
          },
        },
      },
      take: 25,
    });

    if (manufacturers.length === 0) {
      await interaction.reply({
        content: '📭 Aktuell sind keine Downloads verfügbar.',
        ephemeral: true,
      });
      return;
    }

    // ── Schritt 1: Hersteller-Dropdown ──
    const embed = createBotEmbed({
      title: '📥 Download-Bereich',
      description: [
        Brand.divider,
        `**${manufacturers.length} Hersteller** verfügbar.`,
        'Wähle einen Hersteller aus dem Dropdown.',
        Brand.divider,
      ].join('\n'),
      color: Colors.Download,
      footer: `${Brand.footerText} • Download`,
      timestamp: true,
    });

    const manufacturerSelect = new StringSelectMenuBuilder()
      .setCustomId('dl_manufacturer')
      .setPlaceholder('🏭 Hersteller auswählen...')
      .addOptions(
        manufacturers.map(m =>
          new StringSelectMenuOptionBuilder()
            .setLabel(m.username)
            .setDescription(`${m._count.packages} Paket(e)`)
            .setValue(m.id)
            .setEmoji('🏭')
        )
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(manufacturerSelect);

    const response = await interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true,
    });

    // ── Collector Schritt 1: Hersteller gewählt ──
    const mfgCollector = response.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 120_000,
    });

    mfgCollector.on('collect', async (mfgInteraction) => {
      if (mfgInteraction.customId !== 'dl_manufacturer') return;

      const selectedUserId = mfgInteraction.values[0];

      // Pakete + Dateien dieses Herstellers laden
      const packages = await prisma.package.findMany({
        where: {
          userId: selectedUserId,
          isDeleted: false,
          files: { some: { isDeleted: false, isQuarantined: false } },
        },
        include: {
          user: { select: { username: true } },
          files: {
            where: { isDeleted: false, isQuarantined: false },
            select: { id: true, originalName: true, fileSize: true },
          },
        },
        take: 25,
        orderBy: { createdAt: 'desc' },
      });

      const manufacturer = packages[0]?.user;

      if (packages.length === 0 || !manufacturer) {
        await mfgInteraction.update({
          embeds: [vEmbed(Colors.Error).setTitle('❌  Keine Pakete').setDescription('Dieser Hersteller hat keine verfügbaren Pakete.')],
          components: [],
        });
        return;
      }

      // ── Schritt 2: Dateien-Dropdown ──
      const options: StringSelectMenuOptionBuilder[] = [];

      for (const pkg of packages) {
        // Einzelne Dateien
        for (const file of pkg.files) {
          options.push(
            new StringSelectMenuOptionBuilder()
              .setLabel(file.originalName)
              .setDescription(`aus ${pkg.name} · ${formatBytes(Number(file.fileSize))}`)
              .setValue(`file_${file.id}`)
              .setEmoji('📄')
          );
        }

        // Discord-Limit: max 25 Optionen
        if (options.length >= 25) break;
      }

      const fileSelect = new StringSelectMenuBuilder()
        .setCustomId('dl_file')
        .setPlaceholder('📂 Datei auswählen...')
        .addOptions(options.slice(0, 25));

      const fileRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fileSelect);

      const detailEmbed = createBotEmbed({
        title: `📥 ${manufacturer.username}`,
        description: [
          Brand.divider,
          `**${packages.length} Paket(e)** verfügbar.`,
          'Wähle eine Datei zum Download.',
          Brand.divider,
        ].join('\n'),
        color: Colors.Download,
        footer: `${Brand.footerText} • Download`,
        timestamp: true,
      });

      const updateResponse = await mfgInteraction.update({
        embeds: [detailEmbed],
        components: [fileRow],
      });

      // ── Collector Schritt 2: Datei/Paket gewählt ──
      const fileCollector = updateResponse.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120_000,
      });

      fileCollector.on('collect', async (fileInteraction) => {
        if (fileInteraction.customId !== 'dl_file') return;

        const val = fileInteraction.values[0];

        await fileInteraction.update({
          embeds: [vEmbed(Colors.Warning).setTitle('⏳  Download wird vorbereitet...')],
          components: [],
        });

        try {
          if (val.startsWith('file_')) {
            const fileId = val.replace('file_', '');
            const result = await downloadSingleFile(fileId, interaction.user.id);

            // Finde den Dateinamen
            let fileName = 'download';
            let pkgName = '';
            for (const pkg of packages) {
              const f = pkg.files.find(f => f.id === fileId);
              if (f) {
                fileName = f.originalName;
                pkgName = pkg.name;
                break;
              }
            }

            if (!result.success || !result.filePath) {
              await interaction.editReply({
                embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription(result.message)],
                components: [],
              });
              return;
            }

            const attachment = new AttachmentBuilder(result.filePath, {
              name: result.fileName || fileName,
            });

            const doneEmbed = vEmbed(Colors.Success)
              .setTitle('📥  Datei-Download')
              .setDescription(
                `${Brand.divider}\n\n` +
                `📄 **${fileName}**\naus **${pkgName}** von **${manufacturer.username}**\n\n` +
                Brand.divider
              );

            await interaction.editReply({ embeds: [doneEmbed], files: [attachment], components: [] });
          }
        } catch (error) {
          await interaction.editReply({
            embeds: [vEmbed(Colors.Error).setTitle('❌  Download fehlgeschlagen').setDescription('Bitte versuche es erneut.')],
            components: [],
          });
        }
      });

      fileCollector.on('end', async (_, reason) => {
        if (reason === 'time') {
          try { await interaction.editReply({ components: [] }); } catch {}
        }
      });

      // Schritt-1-Collector stoppen
      mfgCollector.stop('collected');
    });

    mfgCollector.on('end', async (_, reason) => {
      if (reason === 'time') {
        try { await interaction.editReply({ components: [] }); } catch {}
      }
    });
  },
};

export default downloadCommand;
