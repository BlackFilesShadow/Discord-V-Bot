import {
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  inlineCode,
  userMention,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command } from '../../types';
import { getCaseDetails, getUserCases } from '../../modules/moderation/caseManager';
import {
  listPendingAppeals,
  reviewAppeal,
  revokeModerationCase,
} from '../../modules/moderation/caseAdministration';
import { Colors, vEmbed } from '../../utils/embedDesign';

const NOTE_MAX = 500;

function statusText(active: boolean, revokedAt: Date | null): string {
  if (active) return '🟢 Aktiv';
  return revokedAt ? `⚪ Inaktiv · ${revokedAt.toLocaleString('de-DE')}` : '⚪ Inaktiv';
}

function caseEmbed(modCase: NonNullable<Awaited<ReturnType<typeof getCaseDetails>>>): EmbedBuilder {
  const appeals = modCase.appeals.length
    ? modCase.appeals.map(appeal => `• ${appeal.status} · ${appeal.reason.slice(0, 180)}`).join('\n')
    : 'Keine Appeals';
  return vEmbed(Colors.Moderation)
    .setTitle(`🛡️ Moderation Case #${modCase.caseNumber}`)
    .addFields(
      { name: 'Aktion', value: inlineCode(modCase.action), inline: true },
      { name: 'Status', value: statusText(modCase.isActive, modCase.revokedAt), inline: true },
      { name: 'Eskalation', value: String(modCase.escalationLevel), inline: true },
      { name: 'Ziel', value: `${userMention(modCase.targetUser.discordId)} (${inlineCode(modCase.targetUser.username)})`, inline: false },
      { name: 'Moderator', value: `${userMention(modCase.moderator.discordId)} (${inlineCode(modCase.moderator.username)})`, inline: false },
      { name: 'Grund', value: modCase.reason.slice(0, 1024), inline: false },
      { name: 'Appeals', value: appeals.slice(0, 1024), inline: false },
    )
    .setTimestamp(modCase.createdAt);
}

const data = new SlashCommandBuilder()
  .setName('case')
  .setDescription('Moderations-Cases und Appeals sicher verwalten.')
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .setDMPermission(false)
  .addSubcommand(sub => sub
    .setName('info')
    .setDescription('Zeigt einen Case dieses Servers.')
    .addIntegerOption(option => option.setName('nummer').setDescription('Case-Nummer').setRequired(true).setMinValue(1)))
  .addSubcommand(sub => sub
    .setName('user')
    .setDescription('Zeigt die letzten Cases eines Nutzers auf diesem Server.')
    .addUserOption(option => option.setName('user').setDescription('Nutzer').setRequired(true)))
  .addSubcommand(sub => sub
    .setName('revoke')
    .setDescription('Hebt einen aktiven Case und seine Discord-Sanktion sicher auf.')
    .addIntegerOption(option => option.setName('nummer').setDescription('Case-Nummer').setRequired(true).setMinValue(1))
    .addStringOption(option => option.setName('notiz').setDescription('Grund fuer die Ruecknahme').setRequired(true).setMaxLength(NOTE_MAX)))
  .addSubcommand(sub => sub
    .setName('appeals')
    .setDescription('Zeigt offene Appeals dieses Servers.'))
  .addSubcommand(sub => sub
    .setName('appeal-review')
    .setDescription('Genehmigt oder lehnt den offenen Appeal eines Cases ab.')
    .addIntegerOption(option => option.setName('nummer').setDescription('Case-Nummer').setRequired(true).setMinValue(1))
    .addStringOption(option => option
      .setName('entscheidung')
      .setDescription('Entscheidung')
      .setRequired(true)
      .addChoices(
        { name: 'Genehmigen', value: 'APPROVED' },
        { name: 'Ablehnen', value: 'DENIED' },
      ))
    .addStringOption(option => option.setName('notiz').setDescription('Review-Notiz').setRequired(true).setMaxLength(NOTE_MAX)));

const caseManagementCommand: Command = {
  data,
  cooldown: 2,
  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!interaction.guild || !interaction.guildId) {
      await interaction.reply({ content: '❌ Dieser Command funktioniert nur auf einem Server.', flags: MessageFlags.Ephemeral });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const sub = interaction.options.getSubcommand();

    if (sub === 'info') {
      const caseNumber = interaction.options.getInteger('nummer', true);
      const modCase = await getCaseDetails(caseNumber, interaction.guildId);
      if (!modCase) {
        await interaction.editReply({ content: `❌ Case #${caseNumber} wurde auf diesem Server nicht gefunden.`, allowedMentions: { parse: [] } });
        return;
      }
      await interaction.editReply({ embeds: [caseEmbed(modCase)], allowedMentions: { parse: [] } });
      return;
    }

    if (sub === 'user') {
      const target = interaction.options.getUser('user', true);
      const cases = (await getUserCases(target.id, interaction.guildId)).slice(0, 10);
      const description = cases.length
        ? cases.map(modCase => `**#${modCase.caseNumber}** · ${inlineCode(modCase.action)} · ${modCase.isActive ? 'aktiv' : 'inaktiv'}\n${modCase.reason.slice(0, 180)}`).join('\n\n')
        : 'Keine Cases auf diesem Server.';
      await interaction.editReply({
        embeds: [vEmbed(Colors.Moderation).setTitle(`🛡️ Cases · ${target.username}`).setDescription(description.slice(0, 4000))],
        allowedMentions: { parse: [] },
      });
      return;
    }

    if (sub === 'revoke') {
      const result = await revokeModerationCase({
        guild: interaction.guild,
        caseNumber: interaction.options.getInteger('nummer', true),
        moderatorDiscordId: interaction.user.id,
        note: interaction.options.getString('notiz', true),
      });
      await interaction.editReply({ content: `${result.success ? '✅' : '❌'} ${result.message}`, allowedMentions: { parse: [] } });
      return;
    }

    if (sub === 'appeals') {
      const appeals = await listPendingAppeals(interaction.guildId, 20);
      const description = appeals.length
        ? appeals.map(appeal => `**Case #${appeal.case.caseNumber}** · ${inlineCode(appeal.case.action)} · ${appeal.case.isActive ? 'aktiv' : 'inaktiv'}\n${appeal.user.username} (${inlineCode(appeal.user.discordId)})\n${appeal.reason.slice(0, 220)}`).join('\n\n')
        : 'Keine offenen Appeals.';
      await interaction.editReply({
        embeds: [vEmbed(Colors.Moderation).setTitle('📋 Offene Appeals').setDescription(description.slice(0, 4000))],
        allowedMentions: { parse: [] },
      });
      return;
    }

    const decision = interaction.options.getString('entscheidung', true) as 'APPROVED' | 'DENIED';
    const result = await reviewAppeal({
      guild: interaction.guild,
      caseNumber: interaction.options.getInteger('nummer', true),
      reviewerDiscordId: interaction.user.id,
      decision,
      note: interaction.options.getString('notiz', true),
    });
    await interaction.editReply({ content: `${result.success ? '✅' : '❌'} ${result.message}`, allowedMentions: { parse: [] } });
  },
};

export default caseManagementCommand;
