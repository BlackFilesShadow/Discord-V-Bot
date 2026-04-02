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
    // Hersteller laden, die mindestens 1 aktives Paket ODER Einzeldatei haben
    const manufacturers = await prisma.user.findMany({
      where: {
        isManufacturer: true,
        OR: [
          {
            packages: {
              some: {
                isDeleted: false,
                files: { some: { isDeleted: false, isQuarantined: false } },
              },
            },
          },
          {
            uploads: {
              some: {
                isDeleted: false,
                isQuarantined: false,
                package: {
                  // Einzeldatei ohne Paket (Dummy-Paket oder spezieller Name)
                  name: 'Einzeldownload',
                  isDeleted: false,
                },
              },
            },
          },
        ],
      },
      select: {
        id: true,
        username: true,
        discordId: true,
        packages: {
          where: { isDeleted: false },
          include: {
            files: { where: { isDeleted: false, isQuarantined: false }, select: { id: true, originalName: true, fileSize: true } },
          },
        },
        uploads: {
          where: {
            isDeleted: false,
            isQuarantined: false,
            package: { name: 'Einzeldownload', isDeleted: false },
          },
          select: { id: true, originalName: true, fileSize: true },
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
            .setDescription(`${m.packages.length} Paket(e)`)
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


      // Hersteller-Objekt holen
      const manufacturer = manufacturers.find(m => m.id === selectedUserId);
      if (!manufacturer) {
        await mfgInteraction.update({
          embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Hersteller nicht gefunden.')],
          components: [],
        });
        return;
      }

      // ── Schritt 2: Dateien- und Paket-Dropdown ──
      const options: StringSelectMenuOptionBuilder[] = [];
      // Pakete als Option
      for (const pkg of manufacturer.packages) {
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel(`📦 Paket: ${pkg.name}`)
            .setDescription(`Alle Dateien (${pkg.files.length}) aus Paket ${pkg.name}`)
            .setValue(`package_${pkg.id}`)
            .setEmoji('📦')
        );
        // Einzeldateien im Paket
        for (const file of pkg.files) {
          options.push(
            new StringSelectMenuOptionBuilder()
              .setLabel(file.originalName)
              .setDescription(`aus ${pkg.name} · ${formatBytes(Number(file.fileSize))}`)
              .setValue(`file_${file.id}`)
              .setEmoji('📄')
          );
        }
        if (options.length >= 25) break;
      }
      // Einzeldateien ohne Paket als eigene Einträge
      for (const file of manufacturer.uploads) {
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel(file.originalName)
            .setDescription(`Einzeldownload · ${formatBytes(Number(file.fileSize))}`)
            .setValue(`file_${file.id}`)
            .setEmoji('📄')
        );
      }

      const fileSelect = new StringSelectMenuBuilder()
        .setCustomId('dl_file')
        .setPlaceholder('📦 Paket oder Datei auswählen...')
        .addOptions(options.slice(0, 25));

      const fileRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fileSelect);

      const detailEmbed = createBotEmbed({
        title: `📥 ${manufacturer.username}`,
        description: [
          Brand.divider,
          `**${manufacturer.packages.length} Paket(e)** und **${manufacturer.uploads.length} Einzeldatei(en)** verfügbar.`,
          'Wähle ein Paket (Ordner) oder eine Datei zum Download.',
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
            // Einzeldatei-Download wie bisher
            const fileId = val.replace('file_', '');
            const result = await downloadSingleFile(fileId, interaction.user.id);
            let fileName = 'download';
            let pkgName = '';
            // Suche Datei in Paketen
            for (const pkg of manufacturer.packages) {
              const f = pkg.files.find((f: { id: string }) => f.id === fileId);
              if (f) {
                fileName = f.originalName;
                pkgName = pkg.name;
                break;
              }
            }
            // Falls nicht gefunden, suche in Einzeldateien
            if (!pkgName) {
              const single = manufacturer.uploads.find((f: { id: string }) => f.id === fileId);
              if (single) {
                fileName = single.originalName;
                pkgName = 'Einzeldownload';
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
          } else if (val.startsWith('package_')) {
            // Paket-Download: Alle Dateien als Discord-Uploads in Gruppen à 10
            const packageId = val.replace('package_', '');
            const pkg = manufacturer.packages.find((p: { id: string }) => p.id === packageId);
            if (!pkg) {
              await interaction.editReply({
                embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Paket nicht gefunden.')],
                components: [],
              });
              return;
            }
            if (!pkg.files.length) {
              await interaction.editReply({
                embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Das Paket enthält keine Dateien.')],
                components: [],
              });
              return;
            }
            // Dateien in 10er-Gruppen aufteilen
            const fileGroups = [];
            for (let i = 0; i < pkg.files.length; i += 10) {
              fileGroups.push(pkg.files.slice(i, i + 10));
            }
            for (let i = 0; i < fileGroups.length; i++) {
              const group = fileGroups[i];
              const attachments = [];
              for (const file of group) {
                const result = await downloadSingleFile(file.id, interaction.user.id);
                if (result.success && result.filePath) {
                  attachments.push(new AttachmentBuilder(result.filePath, { name: result.fileName || file.originalName }));
                }
              }
              const embed = vEmbed(Colors.Success)
                .setTitle(`📦 Paket-Download: ${pkg.name}`)
                .setDescription(
                  `${Brand.divider}\n\n` +
                  `**${group.length} Datei(en) aus Paket ${pkg.name}**\n` +
                  `Hersteller: **${manufacturer.username}**\n` +
                  `Nachricht ${i + 1} von ${fileGroups.length}\n\n` +
                  Brand.divider
                );
              if (i === 0) {
                await interaction.editReply({ embeds: [embed], files: attachments, components: [] });
              } else {
                await interaction.followUp({ embeds: [embed], files: attachments, ephemeral: true });
              }
            }
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
