import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  MessageFlags,
} from 'discord.js';
import { Command } from '../../types';
import { searchPackages } from '../../modules/download/downloadHandler';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';

const PER_PAGE = 10;

const searchCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Pakete suchen')
    .setDMPermission(false)
    .addStringOption(opt =>
      opt.setName('query')
        .setDescription('Suchbegriff (Paketname, Nutzer, Beschreibung)')
        .setRequired(true)
        .setMaxLength(120)
    )
    .addStringOption(opt =>
      opt.setName('dateityp').setDescription('Nach Dateityp filtern')
        .setRequired(false)
        .addChoices(
          { name: 'XML', value: 'XML' },
          { name: 'JSON', value: 'JSON' },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('seite').setDescription('Seite').setRequired(false).setMinValue(1).setMaxValue(100)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guildId) {
      await interaction.reply({ content: '❌ Nur in Servern verfügbar.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply();

    const query = interaction.options.getString('query', true);
    const fileType = interaction.options.getString('dateityp') || undefined;
    const page = interaction.options.getInteger('seite') ?? 1;

    const results = await searchPackages(query, {
      fileType,
      limit: PER_PAGE,
      offset: (page - 1) * PER_PAGE,
    });

    if (results.length === 0) {
      await interaction.editReply({ content: `🔍 Keine Pakete für "${query}" gefunden (Seite ${page}).` });
      return;
    }

    const embed = vEmbed(Colors.Info)
      .setTitle(`🔍  Suchergebnisse für "${query}" (Seite ${page})`)
      .setFooter({ text: `${results.length} Ergebnis(se) ${Brand.dot} ${Brand.footerText}` });

    for (const pkg of results) {
      const desc = pkg.description ?? '';
      const truncated = desc.length > 100 ? `${desc.slice(0, 100)}…` : desc;
      embed.addFields({
        name: `📦 ${pkg.name}`,
        value: [
          `👤 Von: ${pkg.user.username}`,
          `📄 Dateien: ${pkg._count.files}`,
          `📥 Downloads: ${pkg._count.downloads}`,
          truncated ? `📝 ${truncated}` : '',
        ].filter(Boolean).join('\n'),
        inline: true,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

export default searchCommand;
