import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { Command } from '../../types';
import { searchPackages } from '../../modules/download/downloadHandler';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';

/**
 * /search Command (Sektion 3):
 * - Suche nach Paketnamen, Dateityp oder Nutzer
 */
const searchCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('search')
    .setDescription('Pakete suchen')
    .addStringOption(opt =>
      opt.setName('query').setDescription('Suchbegriff (Paketname, Nutzer, Beschreibung)').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('dateityp').setDescription('Nach Dateityp filtern')
        .setRequired(false)
        .addChoices(
          { name: 'XML', value: 'XML' },
          { name: 'JSON', value: 'JSON' },
        )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply();

    const query = interaction.options.getString('query', true);
    const fileType = interaction.options.getString('dateityp') || undefined;

    const results = await searchPackages(query, { fileType });

    if (results.length === 0) {
      await interaction.editReply({ content: `🔍 Keine Pakete für "${query}" gefunden.` });
      return;
    }

    const embed = vEmbed(Colors.Info)
      .setTitle(`🔍  Suchergebnisse für "${query}"`)
      .setFooter({ text: `${results.length} Ergebnis(se) ${Brand.dot} ${Brand.footerText}` });

    for (const pkg of results.slice(0, 10)) {
      embed.addFields({
        name: `📦 ${pkg.name}`,
        value: [
          `👤 Von: ${pkg.user.username}`,
          `📄 Dateien: ${pkg._count.files}`,
          `📥 Downloads: ${pkg._count.downloads}`,
          pkg.description ? `📝 ${pkg.description.substring(0, 100)}` : '',
        ].filter(Boolean).join('\n'),
        inline: true,
      });
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

export default searchCommand;
