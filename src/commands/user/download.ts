import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ComponentType,
  MessageFlags,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { downloadSingleFile } from '../../modules/download/downloadHandler';
import { Colors, Brand, vEmbed, formatBytes } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';
import { logger } from '../../utils/logger';

/**
 * /download — Zweistufiges Dropdown:
 *   1. Hersteller waehlen (lazy: nur id+username+packageCount)
 *   2. Paket waehlen (Pakete + Files erst nach Auswahl frisch geladen)
 *   3. Datei wird per Download-Modul ausgeliefert
 *
 * Sicherheit:
 *   - Component-Collector mit user-Filter -> nur der Aufrufer kann interagieren
 *   - Discord-Attachment-Limit aus Konstante (statt Magic-Number verstreut)
 */

const PAGE_SIZE = 25;
// Discord-Limit fuer Bot-Anhaenge in einer regulaeren Nachricht (free tier).
// Wird mehrfach im Bot benoetigt; bei Bedarf in config.upload aufnehmen.
const DISCORD_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const downloadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('download')
    .setDescription('Dateien oder Pakete von Herstellern herunterladen')
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    // K3 LAZY-LOAD: nur Hersteller-IDs/Namen + Paket-Count laden, KEINE Files.
    const manufacturersRaw = await prisma.user.findMany({
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
        _count: { select: { packages: true } },
      },
      orderBy: { username: 'asc' },
      take: 200,
    });

    if (manufacturersRaw.length === 0) {
      await interaction.reply({
        content: '📭 Aktuell sind keine Downloads verfügbar.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const totalPages = Math.max(1, Math.ceil(manufacturersRaw.length / PAGE_SIZE));
    let currentPage = 0;

    const buildManufacturerView = (page: number): {
      embed: EmbedBuilder;
      rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
    } => {
      const slice = manufacturersRaw.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
      const embed = createBotEmbed({
        title: '📥 Download-Bereich',
        description: [
          Brand.divider,
          `**${manufacturersRaw.length} Hersteller** verfügbar.`,
          totalPages > 1 ? `Seite **${page + 1} / ${totalPages}**` : 'Wähle einen Hersteller aus dem Dropdown.',
          Brand.divider,
        ].join('\n'),
        color: Colors.Download,
        footer: `${Brand.footerText} • Download`,
        timestamp: true,
      });
      const select = new StringSelectMenuBuilder()
        .setCustomId('dl_manufacturer')
        .setPlaceholder('🏭 Hersteller auswählen...')
        .addOptions(
          slice.map(m =>
            new StringSelectMenuOptionBuilder()
              .setLabel(m.username.slice(0, 100))
              .setDescription(`${m._count.packages} Paket(e)`)
              .setValue(m.id)
              .setEmoji('🏭'),
          ),
        );
      const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      ];
      if (totalPages > 1) {
        const prev = new ButtonBuilder()
          .setCustomId('dl_mfg_prev').setLabel('◀ Zurück').setStyle(ButtonStyle.Secondary).setDisabled(page === 0);
        const next = new ButtonBuilder()
          .setCustomId('dl_mfg_next').setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1);
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(prev, next));
      }
      return { embed, rows };
    };

    const initial = buildManufacturerView(currentPage);
    await interaction.reply({
      embeds: [initial.embed],
      components: initial.rows,
      flags: MessageFlags.Ephemeral,
    });

    if (!interaction.channel) {
      await interaction.editReply({
        embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Kein Channel gefunden.')],
        components: [],
      });
      return;
    }

    // K4: User-Lock — nur der Aufrufer darf interagieren.
    const mfgCollector = interaction.channel.createMessageComponentCollector({
      time: 120_000,
      filter: i => i.user.id === interaction.user.id,
    });

    mfgCollector.on('collect', async (mfgInteraction) => {
      // Pagination
      if (mfgInteraction.customId === 'dl_mfg_prev' || mfgInteraction.customId === 'dl_mfg_next') {
        currentPage += mfgInteraction.customId === 'dl_mfg_next' ? 1 : -1;
        currentPage = Math.max(0, Math.min(totalPages - 1, currentPage));
        try { await mfgInteraction.deferUpdate(); } catch { /* ack race */ }
        const view = buildManufacturerView(currentPage);
        await interaction.editReply({ embeds: [view.embed], components: view.rows });
        return;
      }

      if (mfgInteraction.customId !== 'dl_manufacturer') return;
      if (mfgInteraction.componentType !== ComponentType.StringSelect) return;

      try { await mfgInteraction.deferUpdate(); } catch { /* */ }
      const selectedUserId = mfgInteraction.values[0];

      // K3: Pakete + Files JETZT erst laden (nach Auswahl).
      const manufacturer = await prisma.user.findUnique({
        where: { id: selectedUserId },
        select: {
          id: true,
          username: true,
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

      const options = manufacturer.packages.slice(0, 25).map(pkg =>
        new StringSelectMenuOptionBuilder()
          .setLabel(`📦 ${pkg.name}`.slice(0, 100))
          .setDescription(`${pkg.files.length} Datei(en)`)
          .setValue(`package_${pkg.id}`)
          .setEmoji('📦'),
      );
      const fileSelect = new StringSelectMenuBuilder()
        .setCustomId('dl_file').setPlaceholder('📦 Paket auswählen...').addOptions(options);
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
      await interaction.editReply({ embeds: [detailEmbed], components: [fileRow] });

      if (!interaction.channel) return;

      // K4: User-Lock auch hier.
      const fileCollector = interaction.channel.createMessageComponentCollector({
        componentType: ComponentType.StringSelect,
        time: 120_000,
        filter: i => i.user.id === interaction.user.id && i.customId === 'dl_file',
      });

      fileCollector.on('collect', async (fileInteraction) => {
        try { await fileInteraction.deferUpdate(); } catch { /* */ }

        await interaction.editReply({
          embeds: [vEmbed(Colors.Warning).setTitle('⏳  Download wird vorbereitet...')],
          components: [],
        });

        const val = fileInteraction.values[0];
        if (!val.startsWith('package_')) return;

        try {
          const packageId = val.replace('package_', '');
          const pkg = manufacturer.packages.find(p => p.id === packageId);
          if (!pkg || pkg.files.length === 0) {
            await interaction.editReply({
              embeds: [vEmbed(Colors.Error).setTitle('❌  Fehler').setDescription('Das Paket enthält keine Dateien.')],
              components: [],
            });
            return;
          }

          const tooLarge: { name: string; size: number }[] = [];
          const sendable = pkg.files.filter(f => {
            if (Number(f.fileSize) > DISCORD_MAX_ATTACHMENT_BYTES) {
              tooLarge.push({ name: f.originalName, size: Number(f.fileSize) });
              return false;
            }
            return true;
          });

          const fileGroups: typeof sendable[] = [];
          for (let i = 0; i < sendable.length; i += 10) {
            fileGroups.push(sendable.slice(i, i + 10));
          }

          if (fileGroups.length === 0 && tooLarge.length > 0) {
            await interaction.editReply({
              embeds: [
                vEmbed(Colors.Warning)
                  .setTitle('⚠️  Dateien zu groß für Discord')
                  .setDescription(
                    `Alle Dateien überschreiten das Discord-Limit von **${formatBytes(DISCORD_MAX_ATTACHMENT_BYTES)}**.\n\n` +
                    tooLarge.map(t => `• \`${t.name}\` (${formatBytes(t.size)})`).join('\n') +
                    `\n\nNutze das Web-Dashboard für große Dateien.`,
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
              Brand.divider, '',
              `**${group.length} Datei(en) aus Paket ${pkg.name}**`,
              `Hersteller: **${manufacturer.username}**`,
              `Nachricht ${i + 1} von ${fileGroups.length}`,
            ];
            if (failed.length) descLines.push('', `⚠️ Fehlgeschlagen: ${failed.map(f => `\`${f}\``).join(', ')}`);
            if (i === fileGroups.length - 1 && tooLarge.length) {
              descLines.push('', `⚠️ Übersprungen (>${formatBytes(DISCORD_MAX_ATTACHMENT_BYTES)}):`,
                ...tooLarge.map(t => `• \`${t.name}\` (${formatBytes(t.size)})`));
            }
            descLines.push('', Brand.divider);

            const embed = vEmbed(Colors.Success)
              .setTitle(`📦 Paket-Download: ${pkg.name}`)
              .setDescription(descLines.join('\n'));

            if (attachments.length === 0) {
              if (i === 0) await interaction.editReply({ embeds: [embed], components: [] });
              else await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
              continue;
            }
            if (i === 0) {
              await interaction.editReply({ embeds: [embed], files: attachments, components: [] });
            } else {
              await interaction.followUp({ embeds: [embed], files: attachments, flags: MessageFlags.Ephemeral });
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

      fileCollector.on('end', async () => {
        try { await interaction.editReply({ components: [] }); } catch { /* */ }
      });

      mfgCollector.stop('collected');
    });
  },
};

export default downloadCommand;
