import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ModalSubmitInteraction,
  TextChannel,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { logger, logAudit } from '../../utils/logger';
import { safeSend } from '../../utils/safeSend';

/**
 * /feedback — User reichen Bug, Idee, Lob oder sonstiges ein.
 * Modal -> DB + optional Admin-Channel-Notification (config.features.feedbackChannelId).
 */

type Category = 'BUG' | 'IDEA' | 'PRAISE' | 'OTHER';
const VALID: Category[] = ['BUG', 'IDEA', 'PRAISE', 'OTHER'];

const labelDe: Record<Category, string> = {
  BUG: '🐛 Bug',
  IDEA: '💡 Idee',
  PRAISE: '🌟 Lob',
  OTHER: '💬 Sonstiges',
};

const colorOf: Record<Category, number> = {
  BUG: Colors.Error,
  IDEA: Colors.Info,
  PRAISE: Colors.Success,
  OTHER: Colors.Primary,
};

const feedbackCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('feedback')
    .setDescription('Sende Bug-Reports, Ideen oder Lob an die Admins')
    .addStringOption(opt =>
      opt
        .setName('kategorie')
        .setDescription('Art des Feedbacks')
        .setRequired(true)
        .addChoices(
          { name: '🐛 Bug-Report', value: 'BUG' },
          { name: '💡 Idee/Feature-Wunsch', value: 'IDEA' },
          { name: '🌟 Lob/Danke', value: 'PRAISE' },
          { name: '💬 Sonstiges', value: 'OTHER' },
        )
    ),
  cooldown: 30,
  execute: async (interaction: ChatInputCommandInteraction) => {
    const category = interaction.options.getString('kategorie', true) as Category;
    if (!VALID.includes(category)) {
      await interaction.reply({ content: '❌ Ungueltige Kategorie.', ephemeral: true });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`feedback_modal_${category}`)
      .setTitle(`Feedback: ${labelDe[category]}`);

    const subject = new TextInputBuilder()
      .setCustomId('subject')
      .setLabel('Kurzbetreff (max 120)')
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(120);

    const message = new TextInputBuilder()
      .setCustomId('message')
      .setLabel('Beschreibung')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(2000);

    modal.addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(subject),
      new ActionRowBuilder<TextInputBuilder>().addComponents(message),
    );

    await interaction.showModal(modal);
  },
};

/**
 * Verarbeitet Feedback-Modal-Submits.
 * Wird aus events/interactionCreate.ts aufgerufen.
 */
export async function handleFeedbackModal(modal: ModalSubmitInteraction): Promise<void> {
  if (!modal.customId.startsWith('feedback_modal_')) return;
  const category = modal.customId.replace('feedback_modal_', '') as Category;
  if (!VALID.includes(category)) {
    await modal.reply({ content: '❌ Ungueltige Kategorie.', ephemeral: true });
    return;
  }

  const subject = modal.fields.getTextInputValue('subject').trim().slice(0, 120);
  const message = modal.fields.getTextInputValue('message').trim().slice(0, 2000);
  if (!subject || !message) {
    await modal.reply({ content: '❌ Betreff und Beschreibung duerfen nicht leer sein.', ephemeral: true });
    return;
  }

  await modal.deferReply({ ephemeral: true });

  try {
    const fb = await prisma.feedback.create({
      data: {
        guildId: modal.guildId,
        userId: modal.user.id,
        username: modal.user.username,
        category,
        subject,
        message,
        status: 'OPEN',
      },
    });

    logAudit('FEEDBACK_SUBMITTED', 'USER', {
      feedbackId: fb.id,
      userId: modal.user.id,
      category,
    });

    // Admin-Channel-Notify, wenn konfiguriert
    const channelId = config.features.feedbackChannelId;
    if (channelId) {
      try {
        const ch = await modal.client.channels.fetch(channelId).catch(() => null);
        if (ch && ch.isTextBased()) {
          const embed = vEmbed(colorOf[category])
            .setTitle(`${labelDe[category]} • ${subject}`)
            .setDescription(message)
            .addFields(
              { name: 'Von', value: `<@${modal.user.id}> (\`${modal.user.id}\`)`, inline: true },
              { name: 'Server', value: modal.guildId ? `\`${modal.guildId}\`` : 'DM', inline: true },
              { name: 'Status', value: '`OPEN`', inline: true },
              { name: 'ID', value: `\`${fb.id}\``, inline: false },
            )
            .setFooter({ text: `${Brand.footerText} • Feedback` });
          await safeSend(ch as TextChannel, { embeds: [embed], allowedMentions: { parse: [] } });
        }
      } catch (e) {
        logger.warn('Feedback-Channel-Notify fehlgeschlagen:', e as Error);
      }
    }

    await modal.editReply({
      embeds: [
        vEmbed(Colors.Success)
          .setTitle('✅ Feedback erhalten')
          .setDescription(
            `Vielen Dank für dein Feedback!\nKategorie: **${labelDe[category]}**\nID: \`${fb.id}\``
          ),
      ],
    });
  } catch (e) {
    logger.error('Feedback-Speicherung fehlgeschlagen:', e as Error);
    try {
      await modal.editReply({
        embeds: [vEmbed(Colors.Error).setTitle('❌ Fehler').setDescription('Feedback konnte nicht gespeichert werden.')],
      });
    } catch { /* */ }
  }
}

export default feedbackCommand;
