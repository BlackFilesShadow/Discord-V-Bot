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
    const embed = new EmbedBuilder()
      .setTitle('📥 Download-Bereich')
      .setDescription(
        `**${manufacturers.length} Hersteller** verfügbar.\n\n` +
        `Wähle einen Hersteller aus dem Dropdown-Menü.`
      )
      .setColor(0x0099ff)
      .setTimestamp();

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
          embeds: [new EmbedBuilder().setTitle('❌ Keine Pakete').setDescription('Dieser Hersteller hat keine verfügbaren Pakete.').setColor(0xff0000)],
          components: [],
        });
        return;
      }

      // ── Schritt 2: Pakete/Dateien-Dropdown ──
      const options: StringSelectMenuOptionBuilder[] = [];

      for (const pkg of packages) {
        // Komplettes Paket als ZIP
        options.push(
          new StringSelectMenuOptionBuilder()
            .setLabel(`📦 ${pkg.name} (ZIP)`)
            .setDescription(`Komplettes Paket · ${pkg.files.length} Datei(en)`)
            .setValue(`zip_${pkg.id}`)
            .setEmoji('📦')
        );

        // Einzelne Dateien
        for (const file of pkg.files.slice(0, 23)) {
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
        .setPlaceholder('📂 Paket oder Datei auswählen...')
        .addOptions(options.slice(0, 25));

      const fileRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(fileSelect);

      const detailEmbed = new EmbedBuilder()
        .setTitle(`📥 ${manufacturer.username}`)
        .setDescription(
          `**${packages.length} Paket(e)** verfügbar.\n\n` +
          `Wähle ein komplettes Paket (ZIP) oder eine einzelne Datei.`
        )
        .setColor(0x0099ff)
        .setTimestamp();

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
          embeds: [new EmbedBuilder().setTitle('⏳ Download wird vorbereitet...').setColor(0xffaa00)],
          components: [],
        });

        try {
          if (val.startsWith('zip_')) {
            const pkgId = val.replace('zip_', '');
            const pkg = packages.find(p => p.id === pkgId);
            const result = await downloadPackageAsZip(pkgId, interaction.user.id);

            if (!result.success || !result.zipBuffer) {
              await interaction.editReply({
                embeds: [new EmbedBuilder().setTitle('❌ Fehler').setDescription(result.message).setColor(0xff0000)],
                components: [],
              });
              return;
            }

            const attachment = new AttachmentBuilder(result.zipBuffer, {
              name: result.fileName || `${pkg?.name || 'paket'}.zip`,
            });

            const doneEmbed = new EmbedBuilder()
              .setTitle('📥 Paket-Download')
              .setDescription(`**${pkg?.name}** von **${manufacturer.username}**`)
              .addFields(
                { name: '📄 Dateien', value: (pkg?.files.length ?? 0).toString(), inline: true },
                { name: '📊 Format', value: 'ZIP', inline: true },
              )
              .setColor(0x00ff00)
              .setTimestamp();

            await interaction.editReply({ embeds: [doneEmbed], files: [attachment], components: [] });
          } else if (val.startsWith('file_')) {
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
                embeds: [new EmbedBuilder().setTitle('❌ Fehler').setDescription(result.message).setColor(0xff0000)],
                components: [],
              });
              return;
            }

            const attachment = new AttachmentBuilder(result.filePath, {
              name: result.fileName || fileName,
            });

            const doneEmbed = new EmbedBuilder()
              .setTitle('📥 Datei-Download')
              .setDescription(`**${fileName}** aus **${pkgName}** von **${manufacturer.username}**`)
              .setColor(0x00ff00)
              .setTimestamp();

            await interaction.editReply({ embeds: [doneEmbed], files: [attachment], components: [] });
          }
        } catch (error) {
          await interaction.editReply({
            embeds: [new EmbedBuilder().setTitle('❌ Download fehlgeschlagen').setDescription('Bitte versuche es erneut.').setColor(0xff0000)],
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export default downloadCommand;
