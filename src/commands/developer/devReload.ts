import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { Command, ExtendedClient } from '../../types';
import { loadCommands, deployCommandsScoped } from '../handler';
import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * /dev-reload – Hot-Reload aller Commands ohne Bot-Neustart.
 * Nur für den Bot-Developer (Passwort-geschützt).
 */
const devReloadCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('dev-reload')
    .setDescription('🔒 Commands hot-reloaden (ohne Neustart)')
    .addStringOption(opt =>
      opt
        .setName('scope')
        .setDescription('Was soll neugeladen werden?')
        .setRequired(true)
        .addChoices(
          { name: 'Alle Commands', value: 'all' },
          { name: 'Nur registrieren (Deploy)', value: 'deploy' },
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const scope = interaction.options.getString('scope', true);
    const client = interaction.client as ExtendedClient;

    try {
      if (scope === 'all') {
        // Commands neu laden
        const oldCount = client.commands.size;
        await loadCommands(client);
        const newCount = client.commands.size;

        // Scope-getrennt registrieren: global (Admin/Dev/Manufacturer) + guild (Rest).
        const guildIds = [...client.guilds.cache.keys()];
        const res = await deployCommandsScoped(client, config.discord.token, config.discord.clientId, guildIds);

        const embed = new EmbedBuilder()
          .setTitle('🔄 Commands neugeladen')
          .setColor(0x00ff00)
          .addFields(
            { name: 'Vorher', value: `${oldCount} Commands`, inline: true },
            { name: 'Nachher', value: `${newCount} Commands`, inline: true },
            { name: 'Scope', value: `${res.globalCount} global · ${res.guildCount} guild (${res.guildsOk} Guilds)`, inline: true },
          )
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        logger.info(`Dev-Reload: ${newCount} Commands neugeladen von ${interaction.user.tag}`);
      } else {
        // Nur bei Discord neu registrieren (scope-getrennt)
        const guildIds = [...client.guilds.cache.keys()];
        const res = await deployCommandsScoped(client, config.discord.token, config.discord.clientId, guildIds);

        const embed = new EmbedBuilder()
          .setTitle('📡 Commands deployed')
          .setColor(0x00ff00)
          .setDescription(`${res.globalCount} global · ${res.guildCount} guild-scoped auf ${res.guildsOk} Guild(s) registriert.`)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      }
    } catch (error) {
      logger.error('Dev-Reload fehlgeschlagen:', error);
      await interaction.editReply({
        content: `❌ Reload fehlgeschlagen: ${error instanceof Error ? error.message : 'Unbekannt'}`,
      });
    }
  },
};

export default devReloadCommand;
