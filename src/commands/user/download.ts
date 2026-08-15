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
import { checkRateLimit } from '../../utils/rateLimiter';

/**
 * /download — oeffentlicher Hersteller-Download.
 *
 * Produktions-Invarianten:
 * - nur ACTIVE + isManufacturer + role=MANUFACTURER werden angeboten;
 * - nur ACTIVE-Pakete mit VALID/nicht quarantinierten Dateien werden angeboten;
 * - Hersteller- und Paketlisten sind paginiert (kein stilles 25er-Limit);
 * - Collector laufen auf der konkreten ephemeral Nachricht, nicht kanalweit;
 * - ein Paketaufruf verbraucht genau EIN Download-Rate-Limit-Budget, auch wenn
 *   mehrere Dateien ausgeliefert werden;
 * - jede Datei wird im Download-Service nochmals frisch validiert/getrackt.
 */

const PAGE_SIZE = 25;
const DISCORD_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const PUBLIC_FILE_FILTER = {
  isDeleted: false,
  isQuarantined: false,
  isValid: true,
  validationStatus: 'VALID' as const,
};

const downloadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('download')
    .setDescription('Validierte Dateien oder Pakete von Herstellern herunterladen')
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const manufacturersRaw = await prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        isManufacturer: true,
        role: 'MANUFACTURER',
        packages: {
          some: {
            isDeleted: false,
            status: 'ACTIVE',
            files: { some: PUBLIC_FILE_FILTER },
          },
        },
      },
      select: {
        id: true,
        username: true,
        _count: {
          select: {
            packages: {
              where: {
                isDeleted: false,
                status: 'ACTIVE',
                files: { some: PUBLIC_FILE_FILTER },
              },
            },
          },
        },
      },
      orderBy: { username: 'asc' },
      take: 500,
    });

    if (manufacturersRaw.length === 0) {
      await interaction.reply({
        embeds: [vEmbed(Colors.Info).setTitle('📭 Keine Downloads').setDescription('Aktuell sind keine validierten Hersteller-Downloads verfuegbar.')],
        flags: MessageFlags.Ephemeral,
        allowedMentions: { parse: [] },
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
          `**${manufacturersRaw.length} Hersteller** mit validierten Downloads verfuegbar.`,
          totalPages > 1 ? `Seite **${page + 1} / ${totalPages}**` : 'Waehle einen Hersteller aus dem Dropdown.',
          Brand.divider,
        ].join('\n'),
        color: Colors.Download,
        footer: `${Brand.footerText} • Download`,
        timestamp: true,
      });
      const select = new StringSelectMenuBuilder()
        .setCustomId('dl_manufacturer')
        .setPlaceholder('🏭 Hersteller auswaehlen...')
        .addOptions(
          slice.map(m => new StringSelectMenuOptionBuilder()
            .setLabel(m.username.slice(0, 100))
            .setDescription(`${m._count.packages} Paket(e)`)
            .setValue(m.id)
            .setEmoji('🏭')),
        );
      const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
      ];
      if (totalPages > 1) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('dl_mfg_prev').setLabel('◀ Zurueck').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
          new ButtonBuilder()
            .setCustomId('dl_mfg_next').setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
        ));
      }
      return { embed, rows };
    };

    const initial = buildManufacturerView(currentPage);
    await interaction.reply({
      embeds: [initial.embed],
      components: initial.rows,
      flags: MessageFlags.Ephemeral,
      allowedMentions: { parse: [] },
    });
    const response = await interaction.fetchReply();

    const mfgCollector = response.createMessageComponentCollector({
      time: 120_000,
      filter: component => component.user.id === interaction.user.id,
    });

    mfgCollector.on('collect', async mfgInteraction => {
      if (mfgInteraction.customId === 'dl_mfg_prev' || mfgInteraction.customId === 'dl_mfg_next') {
        currentPage += mfgInteraction.customId === 'dl_mfg_next' ? 1 : -1;
        currentPage = Math.max(0, Math.min(totalPages - 1, currentPage));
        const view = buildManufacturerView(currentPage);
        await mfgInteraction.update({ embeds: [view.embed], components: view.rows });
        return;
      }
      if (mfgInteraction.customId !== 'dl_manufacturer' || mfgInteraction.componentType !== ComponentType.StringSelect) return;

      const selectedUserId = mfgInteraction.values[0];
      const manufacturer = await prisma.user.findFirst({
        where: {
          id: selectedUserId,
          status: 'ACTIVE',
          isManufacturer: true,
          role: 'MANUFACTURER',
        },
        select: {
          id: true,
          username: true,
          packages: {
            where: {
              isDeleted: false,
              status: 'ACTIVE',
              files: { some: PUBLIC_FILE_FILTER },
            },
            include: {
              files: {
                where: PUBLIC_FILE_FILTER,
                select: { id: true, originalName: true, fileSize: true },
                orderBy: { createdAt: 'asc' },
              },
            },
            orderBy: { createdAt: 'desc' },
          },
        },
      });

      if (!manufacturer || manufacturer.packages.length === 0) {
        await mfgInteraction.update({
          embeds: [vEmbed(Colors.Error).setTitle('❌ Nicht mehr verfuegbar').setDescription('Der Hersteller oder seine validierten Pakete sind nicht mehr oeffentlich verfuegbar.')],
          components: [],
        });
        mfgCollector.stop('unavailable');
        return;
      }

      let packagePage = 0;
      const packagePages = Math.max(1, Math.ceil(manufacturer.packages.length / PAGE_SIZE));
      const buildPackageView = (page: number): {
        embed: EmbedBuilder;
        rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[];
      } => {
        const slice = manufacturer.packages.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
        const select = new StringSelectMenuBuilder()
          .setCustomId('dl_package')
          .setPlaceholder('📦 Paket auswaehlen...')
          .addOptions(slice.map(pkg => new StringSelectMenuOptionBuilder()
            .setLabel(pkg.name.slice(0, 100))
            .setDescription(`${pkg.files.length} validierte Datei(en)`)
            .setValue(pkg.id)
            .setEmoji('📦')));
        const rows: ActionRowBuilder<StringSelectMenuBuilder | ButtonBuilder>[] = [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
        ];
        if (packagePages > 1) {
          rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setCustomId('dl_pkg_prev').setLabel('◀ Zurueck').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
            new ButtonBuilder()
              .setCustomId('dl_pkg_next').setLabel('Weiter ▶').setStyle(ButtonStyle.Secondary).setDisabled(page >= packagePages - 1),
          ));
        }
        const embed = createBotEmbed({
          title: `📥 ${manufacturer.username}`,
          description: [
            Brand.divider,
            `**${manufacturer.packages.length} Paket(e)** mit validierten Dateien.`,
            packagePages > 1 ? `Seite **${page + 1} / ${packagePages}**` : 'Waehle ein Paket.',
            Brand.divider,
          ].join('\n'),
          color: Colors.Download,
          footer: `${Brand.footerText} • Download`,
          timestamp: true,
        });
        return { embed, rows };
      };

      const packageView = buildPackageView(packagePage);
      await mfgInteraction.update({ embeds: [packageView.embed], components: packageView.rows });
      mfgCollector.stop('manufacturer-selected');

      const packageCollector = response.createMessageComponentCollector({
        time: 120_000,
        filter: component => component.user.id === interaction.user.id,
      });

      packageCollector.on('collect', async packageInteraction => {
        if (packageInteraction.customId === 'dl_pkg_prev' || packageInteraction.customId === 'dl_pkg_next') {
          packagePage += packageInteraction.customId === 'dl_pkg_next' ? 1 : -1;
          packagePage = Math.max(0, Math.min(packagePages - 1, packagePage));
          const view = buildPackageView(packagePage);
          await packageInteraction.update({ embeds: [view.embed], components: view.rows });
          return;
        }
        if (packageInteraction.customId !== 'dl_package' || packageInteraction.componentType !== ComponentType.StringSelect) return;

        const packageId = packageInteraction.values[0];
        const pkg = manufacturer.packages.find(p => p.id === packageId);
        if (!pkg || pkg.files.length === 0) {
          await packageInteraction.update({
            embeds: [vEmbed(Colors.Error).setTitle('❌ Paket nicht verfuegbar').setDescription('Das ausgewaehlte Paket enthaelt keine validierten Dateien mehr.')],
            components: [],
          });
          packageCollector.stop('missing');
          return;
        }

        const tooLarge: { name: string; size: number }[] = [];
        const sendable = pkg.files.filter(file => {
          const size = Number(file.fileSize);
          if (size > DISCORD_MAX_ATTACHMENT_BYTES) {
            tooLarge.push({ name: file.originalName, size });
            return false;
          }
          return true;
        });

        if (sendable.length === 0) {
          await packageInteraction.update({
            embeds: [
              vEmbed(Colors.Warning)
                .setTitle('⚠️ Dateien zu gross fuer Discord')
                .setDescription(
                  `Alle validierten Dateien ueberschreiten das Discord-Limit von **${formatBytes(DISCORD_MAX_ATTACHMENT_BYTES)}**.\n\n` +
                  tooLarge.slice(0, 20).map(t => `• \`${t.name}\` (${formatBytes(t.size)})`).join('\n') +
                  '\n\nNutze fuer grosse Dateien das Web-Dashboard.',
                ),
            ],
            components: [],
          });
          packageCollector.stop('too-large');
          return;
        }

        const rl = await checkRateLimit(interaction.user.id, 'download');
        if (!rl.allowed) {
          await packageInteraction.update({
            embeds: [vEmbed(Colors.Warning).setTitle('⏳ Download-Limit erreicht').setDescription(`Bitte versuche es <t:${Math.floor(rl.resetAt.getTime() / 1000)}:R> erneut.`)],
            components: [],
          });
          packageCollector.stop('rate-limited');
          return;
        }

        await packageInteraction.update({
          embeds: [vEmbed(Colors.Warning).setTitle('⏳ Download wird vorbereitet...').setDescription(`**${sendable.length}** validierte Datei(en) werden frisch geprueft.`)],
          components: [],
        });
        packageCollector.stop('selected');

        const fileGroups: typeof sendable[] = [];
        for (let idx = 0; idx < sendable.length; idx += 10) fileGroups.push(sendable.slice(idx, idx + 10));

        for (let groupIndex = 0; groupIndex < fileGroups.length; groupIndex++) {
          const group = fileGroups[groupIndex];
          const attachments: AttachmentBuilder[] = [];
          const failed: string[] = [];

          for (const file of group) {
            try {
              const result = await downloadSingleFile(file.id, interaction.user.id, { skipRateLimit: true });
              if (result.success && result.filePath) {
                attachments.push(new AttachmentBuilder(result.filePath, { name: result.fileName || file.originalName }));
              } else {
                failed.push(file.originalName);
              }
            } catch (error) {
              logger.warn(`Download-Datei ${file.id} konnte nicht ausgeliefert werden: ${error instanceof Error ? error.message : String(error)}`);
              failed.push(file.originalName);
            }
          }

          const descLines = [
            Brand.divider,
            '',
            `**${attachments.length}/${group.length} Datei(en) aus ${pkg.name}**`,
            `Hersteller: **${manufacturer.username}**`,
            `Nachricht ${groupIndex + 1} von ${fileGroups.length}`,
          ];
          if (failed.length) descLines.push('', `⚠️ Nicht mehr verfuegbar: ${failed.map(f => `\`${f}\``).join(', ')}`);
          if (groupIndex === fileGroups.length - 1 && tooLarge.length) {
            descLines.push(
              '',
              `⚠️ Nicht per Discord sendbar (>${formatBytes(DISCORD_MAX_ATTACHMENT_BYTES)}):`,
              ...tooLarge.slice(0, 20).map(t => `• \`${t.name}\` (${formatBytes(t.size)})`),
            );
          }
          descLines.push('', Brand.divider);

          const embed = vEmbed(attachments.length > 0 ? Colors.Success : Colors.Warning)
            .setTitle(`📦 Paket-Download: ${pkg.name}`)
            .setDescription(descLines.join('\n').slice(0, 4000));

          if (groupIndex === 0) {
            await interaction.editReply({ embeds: [embed], files: attachments, components: [] });
          } else {
            await interaction.followUp({
              embeds: [embed],
              files: attachments,
              flags: MessageFlags.Ephemeral,
              allowedMentions: { parse: [] },
            });
          }
        }
      });

      packageCollector.on('end', async (_collected, reason) => {
        if (reason === 'time') {
          try { await interaction.editReply({ components: [] }); } catch { /* interaction gone */ }
        }
      });
    });

    mfgCollector.on('end', async (_collected, reason) => {
      if (reason === 'time') {
        try { await interaction.editReply({ components: [] }); } catch { /* interaction gone */ }
      }
    });
  },
};

export default downloadCommand;
