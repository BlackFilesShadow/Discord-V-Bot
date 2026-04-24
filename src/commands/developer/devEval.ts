import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import os from 'os';

/**
 * /dev-eval – Developer-Diagnostik-Command.
 * Nur nach Passwort-Eingabe sichtbar/nutzbar.
 */
const devEvalCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('dev-eval')
    .setDescription('🔒 Developer-Diagnostik & Systemcheck')
    .addStringOption(opt =>
      opt
        .setName('check')
        .setDescription('Diagnostik-Typ')
        .setRequired(true)
        .addChoices(
          { name: 'System-Info', value: 'system' },
          { name: 'DB-Stats', value: 'db' },
          { name: 'Memory', value: 'memory' },
          { name: 'Bot-Uptime', value: 'uptime' },
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  devOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const check = interaction.options.getString('check', true);
    const embed = new EmbedBuilder().setColor(0x9b59b6).setTimestamp();

    switch (check) {
      case 'system': {
        const mem = process.memoryUsage();
        embed
          .setTitle('🖥️ System-Diagnostik')
          .addFields(
            { name: 'OS', value: `${os.type()} ${os.release()}`, inline: true },
            { name: 'CPU', value: `${os.cpus()[0]?.model || 'Unknown'} (${os.cpus().length} Kerne)`, inline: true },
            { name: 'Node.js', value: process.version, inline: true },
            { name: 'RAM Total', value: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(1)} GB`, inline: true },
            { name: 'RAM Frei', value: `${(os.freemem() / 1024 / 1024 / 1024).toFixed(1)} GB`, inline: true },
            { name: 'Heap Used', value: `${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`, inline: true },
          );
        break;
      }

      case 'db': {
        try {
          const [userCount, pkgCount, uploadCount] = await Promise.all([
            prisma.user.count(),
            prisma.package.count(),
            prisma.upload.count(),
          ]);
          embed
            .setTitle('🗄️ Datenbank-Statistik')
            .addFields(
              { name: 'Users', value: userCount.toString(), inline: true },
              { name: 'Pakete', value: pkgCount.toString(), inline: true },
              { name: 'Uploads', value: uploadCount.toString(), inline: true },
            );
        } catch (e) {
          embed
            .setColor(0xe74c3c)
            .setTitle('❌ DB nicht erreichbar')
            .setDescription(String((e as Error)?.message ?? e).slice(0, 1000));
        }
        break;
      }

      case 'memory': {
        const mem = process.memoryUsage();
        embed
          .setTitle('💾 Memory-Details')
          .addFields(
            { name: 'RSS', value: `${(mem.rss / 1024 / 1024).toFixed(2)} MB`, inline: true },
            { name: 'Heap Total', value: `${(mem.heapTotal / 1024 / 1024).toFixed(2)} MB`, inline: true },
            { name: 'Heap Used', value: `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB`, inline: true },
            { name: 'External', value: `${(mem.external / 1024 / 1024).toFixed(2)} MB`, inline: true },
            { name: 'Array Buffers', value: `${(mem.arrayBuffers / 1024 / 1024).toFixed(2)} MB`, inline: true },
          );
        break;
      }

      case 'uptime': {
        const uptimeMs = interaction.client.uptime || 0;
        const hrs = Math.floor(uptimeMs / 3600000);
        const mins = Math.floor((uptimeMs % 3600000) / 60000);
        const secs = Math.floor((uptimeMs % 60000) / 1000);
        embed
          .setTitle('⏱️ Bot-Uptime')
          .addFields(
            { name: 'Uptime', value: `${hrs}h ${mins}m ${secs}s`, inline: true },
            { name: 'Guilds', value: interaction.client.guilds.cache.size.toString(), inline: true },
            { name: 'Users (cached)', value: interaction.client.users.cache.size.toString(), inline: true },
            { name: 'Channels (cached)', value: interaction.client.channels.cache.size.toString(), inline: true },
          );
        break;
      }
    }

    await interaction.editReply({ embeds: [embed] });
  },
};

export default devEvalCommand;
