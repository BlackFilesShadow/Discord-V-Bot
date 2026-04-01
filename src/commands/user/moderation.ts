import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from '../../types';
import { createModerationCase, createAppeal } from '../../modules/moderation/caseManager';

/**
 * /kick Command (Sektion 4: Kick).
 */
export const kickCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Einen Nutzer kicken')
    .addUserOption(opt => opt.setName('user').setDescription('Der zu kickende Nutzer').setRequired(true))
    .addStringOption(opt => opt.setName('grund').setDescription('Grund für den Kick').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers),
  permissions: ['KickMembers'],

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guild) return;
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund', true);

    const result = await createModerationCase({
      targetDiscordId: targetUser.id,
      moderatorDiscordId: interaction.user.id,
      action: 'KICK',
      reason,
      guild: interaction.guild,
    });

    const embed = new EmbedBuilder()
      .setTitle(result.success ? '🦶 Nutzer gekickt' : '❌ Fehler')
      .setDescription(result.message)
      .setColor(result.success ? 0xff9900 : 0xff0000)
      .addFields(
        { name: 'Nutzer', value: `${targetUser.tag}`, inline: true },
        { name: 'Grund', value: reason, inline: true },
        { name: 'Case', value: result.caseNumber ? `#${result.caseNumber}` : 'N/A', inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

/**
 * /ban Command (Sektion 4: Ban, temporär oder permanent).
 */
export const banCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Einen Nutzer bannen')
    .addUserOption(opt => opt.setName('user').setDescription('Der zu bannende Nutzer').setRequired(true))
    .addStringOption(opt => opt.setName('grund').setDescription('Grund für den Ban').setRequired(true))
    .addIntegerOption(opt => opt.setName('dauer').setDescription('Dauer in Minuten (leer = permanent)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
  permissions: ['BanMembers'],

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guild) return;
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund', true);
    const duration = interaction.options.getInteger('dauer') || undefined;

    const action = duration ? 'TEMP_BAN' : 'BAN';

    const result = await createModerationCase({
      targetDiscordId: targetUser.id,
      moderatorDiscordId: interaction.user.id,
      action,
      reason,
      duration,
      guild: interaction.guild,
    });

    const embed = new EmbedBuilder()
      .setTitle(result.success ? '🔨 Nutzer gebannt' : '❌ Fehler')
      .setDescription(result.message)
      .setColor(result.success ? 0xff0000 : 0xff0000)
      .addFields(
        { name: 'Nutzer', value: `${targetUser.tag}`, inline: true },
        { name: 'Grund', value: reason, inline: true },
        { name: 'Dauer', value: duration ? `${duration} Minuten` : 'Permanent', inline: true },
        { name: 'Case', value: result.caseNumber ? `#${result.caseNumber}` : 'N/A', inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

/**
 * /mute Command (Sektion 4: Mute, temporär oder permanent).
 */
export const muteCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Einen Nutzer muten')
    .addUserOption(opt => opt.setName('user').setDescription('Der zu mutende Nutzer').setRequired(true))
    .addStringOption(opt => opt.setName('grund').setDescription('Grund für den Mute').setRequired(true))
    .addIntegerOption(opt => opt.setName('dauer').setDescription('Dauer in Minuten (leer = 28 Tage)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  permissions: ['ModerateMembers'],

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guild) return;
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund', true);
    const duration = interaction.options.getInteger('dauer') || undefined;

    const action = duration ? 'TEMP_MUTE' : 'MUTE';

    const result = await createModerationCase({
      targetDiscordId: targetUser.id,
      moderatorDiscordId: interaction.user.id,
      action,
      reason,
      duration,
      guild: interaction.guild,
    });

    const embed = new EmbedBuilder()
      .setTitle(result.success ? '🔇 Nutzer gemutet' : '❌ Fehler')
      .setDescription(result.message)
      .setColor(result.success ? 0xffcc00 : 0xff0000)
      .addFields(
        { name: 'Nutzer', value: `${targetUser.tag}`, inline: true },
        { name: 'Grund', value: reason, inline: true },
        { name: 'Dauer', value: duration ? `${duration} Minuten` : '28 Tage', inline: true },
        { name: 'Case', value: result.caseNumber ? `#${result.caseNumber}` : 'N/A', inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

/**
 * /warn Command (Sektion 4: Warn).
 */
export const warnCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Einen Nutzer verwarnen')
    .addUserOption(opt => opt.setName('user').setDescription('Der zu verwarnende Nutzer').setRequired(true))
    .addStringOption(opt => opt.setName('grund').setDescription('Grund für die Verwarnung').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers),
  permissions: ['ModerateMembers'],

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guild) return;
    await interaction.deferReply();

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund', true);

    const result = await createModerationCase({
      targetDiscordId: targetUser.id,
      moderatorDiscordId: interaction.user.id,
      action: 'WARN',
      reason,
      guild: interaction.guild,
    });

    const embed = new EmbedBuilder()
      .setTitle(result.success ? '⚠️ Nutzer verwarnt' : '❌ Fehler')
      .setDescription(result.message)
      .setColor(result.success ? 0xffdd00 : 0xff0000)
      .addFields(
        { name: 'Nutzer', value: `${targetUser.tag}`, inline: true },
        { name: 'Grund', value: reason, inline: true },
        { name: 'Case', value: result.caseNumber ? `#${result.caseNumber}` : 'N/A', inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};

/**
 * /appeal Command (Sektion 4: Appeal-System).
 */
export const appealCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('appeal')
    .setDescription('Beschwerde gegen eine Moderationsaktion einreichen')
    .addIntegerOption(opt =>
      opt.setName('case').setDescription('Case-Nummer').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('begruendung').setDescription('Begründung für den Appeal').setRequired(true)
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const caseNumber = interaction.options.getInteger('case', true);
    const reason = interaction.options.getString('begruendung', true);

    const result = await createAppeal(caseNumber, interaction.user.id, reason);

    const embed = new EmbedBuilder()
      .setTitle(result.success ? '📋 Appeal eingereicht' : '❌ Fehler')
      .setDescription(result.message)
      .setColor(result.success ? 0x0099ff : 0xff0000)
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  },
};
