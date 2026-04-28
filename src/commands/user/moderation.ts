import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  MessageFlags,
  userMention,
  inlineCode,
} from 'discord.js';
import { Command } from '../../types';
import { createModerationCase, createAppeal } from '../../modules/moderation/caseManager';
import { Colors, vEmbed } from '../../utils/embedDesign';

// ── Konstanten ────────────────────────────────────────────────
const REASON_MAX_LENGTH = 500;            // Discord-Audit-Reason hard-limit ist 512
const MUTE_DEFAULT_MIN  = 60;             // 1 Stunde
const MUTE_MAX_MIN      = 28 * 24 * 60;   // 40320 = Discord-Timeout-Maximum (28 Tage)
const BAN_MAX_MIN       = 365 * 24 * 60;  // 525600 = 1 Jahr (Soft-Cap, größere Bans bewusst manuell)
const APPEAL_REASON_MAX = 1000;

// ── Helpers ───────────────────────────────────────────────────

/**
 * DM-Schutz: Beendet die Interaction sauber, wenn der Command in einer DM
 * aufgerufen wurde. Ergänzt `setDMPermission(false)` für den Fall, dass
 * Discord die Anfrage trotzdem zustellt (z. B. Cache-Lag nach Deploy).
 */
async function dmGuard(interaction: ChatInputCommandInteraction): Promise<boolean> {
  if (interaction.guild) return true;
  await interaction.reply({
    content: '❌ Dieser Command funktioniert nur auf einem Server.',
    flags: MessageFlags.Ephemeral,
  });
  return false;
}

/** Einheitliche Ziel-Anzeige: Mention + Username (auch für migrierte Discord-Accounts). */
function targetDisplay(userId: string, username: string): string {
  return `${userMention(userId)} (${inlineCode(username)})`;
}

/** Fügt das Case-Feld nur an, wenn ein Case existiert. */
function caseField(caseNumber?: number): { name: string; value: string; inline: boolean }[] {
  return caseNumber
    ? [{ name: '📋 Case', value: `#${caseNumber}`, inline: true }]
    : [];
}

// ═════════════════════════════════════════════════════════════
// /kick
// ═════════════════════════════════════════════════════════════

/** Kickt einen Nutzer vom Server und legt einen Moderation-Case an. */
export const kickCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('kick')
    .setDescription('Nutzer vom Server entfernen und Case-Eintrag erstellen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Zu kickender Nutzer').setRequired(true),
    )
    .addStringOption(opt =>
      opt.setName('grund')
        .setDescription('Grund für den Kick')
        .setRequired(true)
        .setMaxLength(REASON_MAX_LENGTH),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!await dmGuard(interaction)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund', true);

    const result = await createModerationCase({
      targetDiscordId: targetUser.id,
      moderatorDiscordId: interaction.user.id,
      action: 'KICK',
      reason,
      guild: interaction.guild!,
    });

    const embed = vEmbed(result.success ? Colors.Moderation : Colors.Error)
      .setTitle(result.success ? '🦶  Nutzer gekickt' : '❌  Kick fehlgeschlagen')
      .setDescription(result.message)
      .addFields(
        { name: '👤 Nutzer', value: targetDisplay(targetUser.id, targetUser.username), inline: true },
        ...caseField(result.caseNumber),
        { name: '📝 Grund', value: reason, inline: false },
      );

    await interaction.editReply({ embeds: [embed] });
  },
};

// ═════════════════════════════════════════════════════════════
// /ban
// ═════════════════════════════════════════════════════════════

/** Bannt einen Nutzer (permanent oder temporär) und legt einen Case an. */
export const banCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Nutzer bannen (permanent oder temporär) und Case erstellen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Zu bannender Nutzer').setRequired(true),
    )
    .addStringOption(opt =>
      opt.setName('grund')
        .setDescription('Grund für den Ban')
        .setRequired(true)
        .setMaxLength(REASON_MAX_LENGTH),
    )
    .addIntegerOption(opt =>
      opt.setName('dauer')
        .setDescription('Dauer in Minuten — leer lassen für permanent')
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(BAN_MAX_MIN),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!await dmGuard(interaction)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund', true);
    const duration = interaction.options.getInteger('dauer') ?? undefined;
    const action = duration ? 'TEMP_BAN' : 'BAN';

    const result = await createModerationCase({
      targetDiscordId: targetUser.id,
      moderatorDiscordId: interaction.user.id,
      action,
      reason,
      duration,
      guild: interaction.guild!,
    });

    const embed = vEmbed(result.success ? Colors.Moderation : Colors.Error)
      .setTitle(result.success ? '🔨  Nutzer gebannt' : '❌  Ban fehlgeschlagen')
      .setDescription(result.message)
      .addFields(
        { name: '👤 Nutzer', value: targetDisplay(targetUser.id, targetUser.username), inline: true },
        { name: '⏰ Dauer', value: duration ? `${duration} Min.` : 'Permanent', inline: true },
        ...caseField(result.caseNumber),
        { name: '📝 Grund', value: reason, inline: false },
      );

    await interaction.editReply({ embeds: [embed] });
  },
};

// ═════════════════════════════════════════════════════════════
// /mute
// ═════════════════════════════════════════════════════════════

/** Mutet einen Nutzer per Discord-Timeout und legt einen Case an. */
export const muteCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('mute')
    .setDescription('Nutzer per Timeout stummschalten (Default 60 Min, max 28 Tage)')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Zu mutender Nutzer').setRequired(true),
    )
    .addStringOption(opt =>
      opt.setName('grund')
        .setDescription('Grund für den Mute')
        .setRequired(true)
        .setMaxLength(REASON_MAX_LENGTH),
    )
    .addIntegerOption(opt =>
      opt.setName('dauer')
        .setDescription(`Dauer in Minuten — Default ${MUTE_DEFAULT_MIN}, max ${MUTE_MAX_MIN} (28 Tage)`)
        .setRequired(false)
        .setMinValue(1)
        .setMaxValue(MUTE_MAX_MIN),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!await dmGuard(interaction)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund', true);
    const duration = interaction.options.getInteger('dauer') ?? MUTE_DEFAULT_MIN;
    // Mute hat IMMER eine Dauer (Default oder explizit) → konsistent TEMP_MUTE
    const action = 'TEMP_MUTE';

    const result = await createModerationCase({
      targetDiscordId: targetUser.id,
      moderatorDiscordId: interaction.user.id,
      action,
      reason,
      duration,
      guild: interaction.guild!,
    });

    const embed = vEmbed(result.success ? Colors.Moderation : Colors.Error)
      .setTitle(result.success ? '🔇  Nutzer gemutet' : '❌  Mute fehlgeschlagen')
      .setDescription(result.message)
      .addFields(
        { name: '👤 Nutzer', value: targetDisplay(targetUser.id, targetUser.username), inline: true },
        { name: '⏰ Dauer', value: `${duration} Min.`, inline: true },
        ...caseField(result.caseNumber),
        { name: '📝 Grund', value: reason, inline: false },
      );

    await interaction.editReply({ embeds: [embed] });
  },
};

// ═════════════════════════════════════════════════════════════
// /warn
// ═════════════════════════════════════════════════════════════

/** Verwarnt einen Nutzer (Case + DM-Benachrichtigung) — keine Discord-Aktion. */
export const warnCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('warn')
    .setDescription('Nutzer verwarnen, Case anlegen und per DM benachrichtigen')
    .addUserOption(opt =>
      opt.setName('user').setDescription('Zu verwarnender Nutzer').setRequired(true),
    )
    .addStringOption(opt =>
      opt.setName('grund')
        .setDescription('Grund für die Verwarnung')
        .setRequired(true)
        .setMaxLength(REASON_MAX_LENGTH),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!await dmGuard(interaction)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const targetUser = interaction.options.getUser('user', true);
    const reason = interaction.options.getString('grund', true);

    const result = await createModerationCase({
      targetDiscordId: targetUser.id,
      moderatorDiscordId: interaction.user.id,
      action: 'WARN',
      reason,
      guild: interaction.guild!,
    });

    const embed = vEmbed(result.success ? Colors.Warning : Colors.Error)
      .setTitle(result.success ? '⚠️  Nutzer verwarnt' : '❌  Verwarnung fehlgeschlagen')
      .setDescription(result.message)
      .addFields(
        { name: '👤 Nutzer', value: targetDisplay(targetUser.id, targetUser.username), inline: true },
        ...caseField(result.caseNumber),
        { name: '📝 Grund', value: reason, inline: false },
      );

    await interaction.editReply({ embeds: [embed] });
  },
};

// ═════════════════════════════════════════════════════════════
// /appeal
// ═════════════════════════════════════════════════════════════

/** Reicht eine Beschwerde gegen eine eigene Moderationsaktion ein.
 *  Muss im Origin-Server des Cases ausgeführt werden (Cross-Guild-Schutz). */
export const appealCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('appeal')
    .setDescription('Beschwerde gegen eine Mod-Aktion einreichen (im Origin-Server des Cases)')
    .addIntegerOption(opt =>
      opt.setName('case-id')
        .setDescription('Case-Nummer (siehe /warn-DM oder Mod-Log)')
        .setRequired(true)
        .setMinValue(1),
    )
    .addStringOption(opt =>
      opt.setName('begruendung')
        .setDescription('Warum sollte die Aktion aufgehoben werden?')
        .setRequired(true)
        .setMaxLength(APPEAL_REASON_MAX),
    )
    .setDMPermission(false),

  execute: async (interaction: ChatInputCommandInteraction) => {
    if (!await dmGuard(interaction)) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const caseNumber = interaction.options.getInteger('case-id', true);
    const reason = interaction.options.getString('begruendung', true);

    const result = await createAppeal(
      caseNumber,
      interaction.user.id,
      reason,
      interaction.guildId ?? undefined,
    );

    const embed: EmbedBuilder = vEmbed(result.success ? Colors.Info : Colors.Error)
      .setTitle(result.success ? '📋  Appeal eingereicht' : '❌  Appeal abgelehnt')
      .setDescription(result.message);

    if (result.success) {
      embed.addFields(
        { name: '📋 Case', value: `#${caseNumber}`, inline: true },
        { name: '📝 Begründung', value: reason, inline: false },
      );
    }

    await interaction.editReply({ embeds: [embed] });
  },
};
