import { ChatInputCommandInteraction, SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { Command } from '../types';
import fs from 'fs/promises';

const aboutPath = __dirname + '/about.md';

const aboutCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('stell-dich-vor')
    .setDescription('Stellt den Bot und seine Features attraktiv vor'),
  async execute(interaction: ChatInputCommandInteraction) {
    let aboutText = '';
    try {
      aboutText = await fs.readFile(aboutPath, 'utf-8');
    } catch {
      aboutText = '🤖 Discord-V-Bot – Dein smarter Community-Manager\n\n(Über mich-Text konnte nicht geladen werden)';
    }
    // Discord-Embeds sind auf 4096 Zeichen limitiert, ggf. splitten
    if (aboutText.length > 4000) aboutText = aboutText.slice(0, 3990) + '...';
    const embed = new EmbedBuilder()
      .setTitle('🤖 Discord-V-Bot – Stell dich vor')
      .setDescription(aboutText)
      .setColor(0x5865F2);
    await interaction.reply({ embeds: [embed], ephemeral: false });
  },
};

export default aboutCommand;
