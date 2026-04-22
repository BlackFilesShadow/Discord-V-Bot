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
import { logger } from '../../utils/logger';

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
    // Hersteller laden, die mindestens 1 aktives Paket mit g\u00fcltiger Datei haben.
    // Strikt nur isManufacturer=true \u2014 Admin/Dev-Uploads gibt es nicht mehr,
    // /upload ist ausnahmslos der Hersteller-Rolle vorbehalten.
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
        packages: {
          where: {
            isDeleted: false,
            files: { some: { isDeleted: false, isQuarantined: false } },
          },
          include: {
            files: { where: { isDeleted: false, isQuarantined: false }, select: { id: true, originalName: true, fileSize: true } },
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
            .setDescription(`${m.packages.length} Paket(e)`)
            .setValue(m.id)
            .setEmoji('🏭')
        )
      );

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(manufacturerSelect);

    await interaction.reply({
      embeds: [embed],
      components: [row],
      ephemeral: true,
    });

    // ── Collector Schritt 1: Hersteller gewählt ──
    if (!interaction.channel) {
      await interaction.editReply({
        embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Kein Channel gefunden.')],
        components: [],
      });
      return;
    }
    const mfgCollector = interaction.channel.createMessageComponentCollector({
      componentType: ComponentType.StringSelect,
      time: 120_000,
    });

    mfgCollector.on('collect', async (mfgInteraction) => {
      if (mfgInteraction.customId !== 'dl_manufacturer') return;

      // SOFORT acknowledgen — DB-Query kann >3s dauern
      try { await mfgInteraction.deferUpdate(); } catch { /* evtl. schon ack */ }

      const selectedUserId = mfgInteraction.values[0];

      // Hersteller-Objekt FRISCH aus DB laden (nicht aus stale closure)
      const manufacturer = await prisma.user.findUnique({
        where: { id: selectedUserId },
        select: {
          id: true,
          username: true,
          discordId: true,
          packages: {
            where: {
              isDeleted: false,
              files: { some: { isDeleted: false, isQuarantined: false } },
            },
            include: {
              files: {
                where: { isDeleted: false, isQuarantined: false },
                select: { id: true, originalName: true, fileSize: true },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      });
      if (!manufacturer || manufacturer.packages.length === 0) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Hersteller hat keine Pakete oder wurde nicht gefunden.')],
          components: [],
        });
        return;
      }

      // ── Schritt 2: Paket-Dropdown (nur Pakete, keine Einzeldateien) ──
      const options: StringSelectMenuOptionBuilder[] = [];
      for (const pkg of manufacturer.packages) {
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel(`📦 ${pkg.name}`)
            .setDescription(`${pkg.files.length} Datei(en)`)
            .setValue(`package_${pkg.id}`)
            .setEmoji('📦')
        );
        if (options.length >= 25) break;
      }

      const fileSelect = new StringSelectMenuBuilder()
        .setCustomId('dl_file')
        .setPlaceholder('📦 Paket auswählen...')
        .addOptions(options.slice(0, 25));

      const fileRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fileSelect);

      const detailEmbed = createBotEmbed({
        title: `📥 ${manufacturer.username}`,
        description: [
          Brand.divider,
          `**${manufacturer.packages.length} Paket(e)** verfügbar.`,
          'Wähle ein Paket (Ordner) zum Download.',
          Brand.divider,
        ].join('\n'),
        color: Colors.Download,
        footer: `${Brand.footerText} • Download`,
        timestamp: true,
      });

      await interaction.editReply({
        embeds: [detailEmbed],
        components: [fileRow],
      });

      // ── Collector Schritt 2: Datei/Paket gewählt ──
      if (!interaction.channel) {
        await interaction.editReply({
          embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Kein Channel gefunden.')],
          components: [],
        });
        return;
      }
      const fileCollector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120_000,
      });

      fileCollector.on('collect', async (fileInteraction) => {
        if (fileInteraction.customId !== 'dl_file') return;

        const val = fileInteraction.values[0];

        // SOFORT acknowledgen — Download/IO kann >3s dauern
        try { await fileInteraction.deferUpdate(); } catch { /* evtl. schon ack */ }

        await interaction.editReply({
          embeds: [vEmbed(Colors.Warning).setTitle('⏳  Download wird vorbereitet...')],
          components: [],
        });

        try {
          if (val.startsWith('package_')) {
            // Paket-Download: Alle Dateien als Discord-Uploads in Gruppen à 10
            const packageId = val.replace('package_', '');
            const pkg = manufacturer.packages.find(p => p.id === packageId);
            const files: any[] = pkg?.files ?? [];
            const pkgName = pkg?.name ?? '';
            if (!files.length) {
              await interaction.editReply({
                embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Das Paket enthält keine Dateien.')],
                components: [],
              });
              return;
            }

            // Discord-Limit: 25 MB pro Anhang (Boost-frei). Größere Dateien als Hinweis.
            const DISCORD_MAX_BYTES = 25 * 1024 * 1024;
            const tooLarge: { name: string; size: number }[] = [];
            const sendable = files.filter(f => {
              if (Number(f.fileSize) > DISCORD_MAX_BYTES) {
                tooLarge.push({ name: f.originalName, size: Number(f.fileSize) });
                return false;
              }
              return true;
            });

            // Dateien in 10er-Gruppen aufteilen
            const fileGroups: any[][] = [];
            for (let i = 0; i < sendable.length; i += 10) {
              fileGroups.push(sendable.slice(i, i + 10));
            }

            if (fileGroups.length === 0 && tooLarge.length > 0) {
              await interaction.editReply({
                embeds: [
                  vEmbed(Colors.Warning)
                    .setTitle('⚠️  Dateien zu groß für Discord')
                    .setDescription(
                      `Alle Dateien überschreiten das Discord-Limit von **25 MB**.\n\n` +
                      tooLarge.map(t => `• \`${t.name}\` (${formatBytes(t.size)})`).join('\n') +
                      `\n\nNutze das Web-Dashboard für große Dateien.`
                    ),
                ],
                components: [],
              });
              return;
            }

            for (let i = 0; i < fileGroups.length; i++) {
              const group = fileGroups[i];
              const attachments: AttachmentBuilder[] = [];
              const failed: string[] = [];
              for (const file of group) {
                try {
                  const result = await downloadSingleFile(file.id, interaction.user.id);
                  if (result.success && result.filePath) {
                    attachments.push(new AttachmentBuilder(result.filePath, { name: result.fileName || file.originalName }));
                  } else {
                    failed.push(file.originalName);
                  }
                } catch {
                  failed.push(file.originalName);
                }
              }

              const descLines = [
                Brand.divider,
                ``,
                `**${group.length} Datei(en) aus Paket ${pkgName}**`,
                `Hersteller: **${manufacturer.username}**`,
                `Nachricht ${i + 1} von ${fileGroups.length}`,
              ];
              if (failed.length) descLines.push(``, `⚠️ Fehlgeschlagen: ${failed.map(f => `\`${f}\``).join(', ')}`);
              if (i === fileGroups.length - 1 && tooLarge.length) {
                descLines.push(``, `⚠️ Übersprungen (>25 MB):`, ...tooLarge.map(t => `• \`${t.name}\` (${formatBytes(t.size)})`));
              }
              descLines.push(``, Brand.divider);

              const embed = vEmbed(Colors.Success)
                .setTitle(`📦 Paket-Download: ${pkgName}`)
                .setDescription(descLines.join('\n'));

              if (attachments.length === 0) {
                if (i === 0) {
                  await interaction.editReply({ embeds: [embed], components: [] });
                } else {
                  await interaction.followUp({ embeds: [embed], ephemeral: true });
                }
                continue;
              }

              if (i === 0) {
                await interaction.editReply({ embeds: [embed], files: attachments, components: [] });
              } else {
                await interaction.followUp({ embeds: [embed], files: attachments, ephemeral: true });
              }
            }
          }
        } catch (error) {
          logger.error('Download-Fehler:', error as Error);
          try {
            await interaction.editReply({
              embeds: [vEmbed(Colors.Error).setTitle('❌  Download fehlgeschlagen').setDescription((error as Error)?.message || 'Bitte versuche es erneut.')],
              components: [],
            });
          } catch { /* */ }
        }
      });

        fileCollector.on('end', async (_, reason) => {
          try { await interaction.editReply({ components: [] }); } catch {}
        });

        // Schritt-1-Collector stoppen
        mfgCollector.stop('collected');
      });
    // }); // Überflüssig, Collector ist bereits korrekt abgeschlossen
  } // Ende execute
};

export default downloadCommand;
