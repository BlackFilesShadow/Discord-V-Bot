import { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';
import { Command } from '../types';
import { Colors, compactDescription, compactEmbed } from '../utils/embedDesign';
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
    const heading = `🤖 ${BOT_PRODUCT_NAME} — aktueller Funktionsstand`;
    const descriptionPrefix = `**${heading}**\n`;
    const availableBodyLength = Math.max(0, 4096 - descriptionPrefix.length);
    const body = description.length > availableBodyLength
      ? `${description.slice(0, Math.max(0, availableBodyLength - 3))}...`
      : description;
    const embed = compactEmbed(Colors.Info, `${BOT_PRODUCT_NAME} • Live-Funktionsuebersicht`)
      .setDescription(compactDescription(heading, [body]));
    await interaction.reply({ embeds: [embed], ephemeral: false });
  },
};

export default aboutCommand;
