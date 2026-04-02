import { SlashCommandBuilder, ChatInputCommandInteraction, PermissionFlagsBits } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /xp-config
 * Konfiguriere XP-Raten und Levelrollen pro Server.
 */
const xpConfigCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('xp-config')
    .setDescription('XP-System konfigurieren (XP-Raten, Levelrollen)')
    .addSubcommand(sub =>
      sub
        .setName('rate')
        .setDescription('XP-Raten einstellen')
        .addIntegerOption(opt =>
          opt.setName('min').setDescription('Minimale XP pro Nachricht').setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('max').setDescription('Maximale XP pro Nachricht').setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('voice').setDescription('XP pro Voice-Minute').setRequired(false)
        )
        .addNumberOption(opt =>
          opt.setName('multiplier').setDescription('XP-Multiplikator').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('levelrole')
        .setDescription('Levelrolle für ein Level setzen')
        .addIntegerOption(opt =>
          opt.setName('level').setDescription('Level').setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Discord-Rolle').setRequired(true)
        )
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) as SlashCommandBuilder,
  adminOnly: true,

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply('❌ Nur auf Servern verfügbar.');
      return;
    }

    if (sub === 'rate') {
      const min = interaction.options.getInteger('min');
      const max = interaction.options.getInteger('max');
      const voice = interaction.options.getInteger('voice');
      const multiplier = interaction.options.getNumber('multiplier');
      const config = await prisma.xpConfig.upsert({
        where: { id: guildId },
        update: {
          ...(min !== null ? { messageXpMin: min } : {}),
          ...(max !== null ? { messageXpMax: max } : {}),
          ...(voice !== null ? { voiceXpPerMinute: voice } : {}),
          ...(multiplier !== null ? { levelMultiplier: multiplier } : {}),
        },
        create: {
          id: guildId,
          messageXpMin: min ?? 15,
          messageXpMax: max ?? 25,
          voiceXpPerMinute: voice ?? 5,
          levelMultiplier: multiplier ?? 1.0,
        },
      });
      await interaction.editReply(`✅ XP-Konfiguration aktualisiert:
Min: ${config.messageXpMin}, Max: ${config.messageXpMax}, Voice: ${config.voiceXpPerMinute}, Multiplikator: ${config.levelMultiplier}`);
    }
    else if (sub === 'levelrole') {
      const level = interaction.options.getInteger('level', true);
      const role = interaction.options.getRole('role', true);
      await prisma.levelRole.upsert({
        where: { guildId_level: { guildId, level } },
        update: { roleId: role.id },
        create: { guildId, level, roleId: role.id },
      });
      await interaction.editReply(`✅ Rolle <@&${role.id}> wird ab Level ${level} automatisch vergeben.`);
    }
  },
};

export default xpConfigCommand;
