import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { Colors, vEmbed } from '../utils/embedDesign';
import { BOT_PRODUCT_NAME, buildBotAboutText } from '../content/botInfo';

/**
 * Oeffentliche Bot-Selbstvorstellung aus derselben kanonischen Quelle wie der
 * Mention-Responder. Keine Runtime-Markdown-Abhaengigkeit und keine getrennt
 * gepflegten, widerspruechlichen Feature-Listen.
 */
const aboutCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('stell-dich-vor')
    .setDescription('Stellt V-Bot Prime und seine aktuell verfuegbaren Bereiche vor'),
  async execute(interaction: ChatInputCommandInteraction) {
    const description = buildBotAboutText();
    const embed = vEmbed(Colors.Info)
      .setTitle(`🤖 ${BOT_PRODUCT_NAME} — aktueller Funktionsstand`)
      .setDescription(description.length > 4096 ? `${description.slice(0, 4093)}...` : description)
      .setFooter({ text: `${BOT_PRODUCT_NAME} • Live-Funktionsuebersicht` });
    await interaction.reply({ embeds: [embed], ephemeral: false });
  },
};

export default aboutCommand;
