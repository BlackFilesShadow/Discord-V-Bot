/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
import {
  MessageFlags,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ChannelType,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { Colors, Brand, compactDescription, compactEmbed } from '../../utils/embedDesign';
import { buildStatusEmbed } from '../../utils/statusEmbed';
import { logger, logAudit } from '../../utils/logger';

/**
 * /erinnerung — User-Reminders mit DM oder Channel-Zustellung.
 * Sub: setzen, liste, loeschen
 */

const UNITS: Record<string, number> = {
  sekunden: 1_000,
  s: 1_000,
  minuten: 60_000,
  m: 60_000,
  stunden: 3_600_000,
  h: 3_600_000,
  tage: 86_400_000,
  d: 86_400_000,
  wochen: 604_800_000,
  w: 604_800_000,
};

const MAX_PER_USER = 25;
const MIN_DURATION_MS = 5_000;            // 5 Sekunden
const MAX_DURATION_MS = 365 * 86_400_000; // 1 Jahr
const MIN_RECURRENCE_MS = 60_000;         // 1 Minute (Spam-Schutz)

const reminderCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('erinnerung')
    .setDescription('Setze, liste oder lösche persönliche Erinnerungen')
    .addSubcommand(sc => sc
      .setName('setzen')
      .setDescription('Neue Erinnerung anlegen')
      .addIntegerOption(o => o.setName('dauer').setDescription('Anzahl Einheiten (z. B. 10)').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('einheit').setDescription('Zeiteinheit').setRequired(true)
        .addChoices(
          { name: 'Sekunden', value: 'sekunden' },
          { name: 'Minuten', value: 'minuten' },
          { name: 'Stunden', value: 'stunden' },
          { name: 'Tage', value: 'tage' },
          { name: 'Wochen', value: 'wochen' },
        ))
      .addStringOption(o => o.setName('text').setDescription('Was soll dich erinnern? (max 500)').setRequired(true).setMaxLength(500))
      .addStringOption(o => o.setName('ziel').setDescription('Wo zustellen?').setRequired(false)
        .addChoices(
          { name: 'DM (Standard)', value: 'dm' },
          { name: 'Aktueller Channel', value: 'channel' },
        ))
      .addBooleanOption(o => o.setName('wiederkehrend').setDescription('Endlos wiederholen (gleiches Intervall)?').setRequired(false))
    )
    .addSubcommand(sc => sc
      .setName('liste')
      .setDescription('Deine aktiven Erinnerungen anzeigen')
    )
    .addSubcommand(sc => sc
      .setName('loeschen')
      .setDescription('Eine deiner Erinnerungen löschen')
      .addStringOption(o => o.setName('id').setDescription('Reminder-ID (aus /erinnerung liste)').setRequired(true))
    ),
  cooldown: 5,
  execute: async (interaction: ChatInputCommandInteraction) => {
    const sub = interaction.options.getSubcommand();
    try {
      await runSub(sub, interaction);
    } catch (e) {
      logger.error(`/erinnerung ${sub} fehlgeschlagen`, e as Error);
      const msg = `❌ Fehler: ${String((e as Error)?.message ?? e).slice(0, 400)}`;
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg });
        else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      } catch { /* */ }
    }
  },
};

async function runSub(sub: string, interaction: ChatInputCommandInteraction): Promise<void> {
  if (sub === 'setzen') {
    const dauer = interaction.options.getInteger('dauer', true);
    const einheit = interaction.options.getString('einheit', true);
    const text = interaction.options.getString('text', true).trim().slice(0, 500);
    const zielArg = interaction.options.getString('ziel') ?? 'dm';
    const recurring = interaction.options.getBoolean('wiederkehrend') ?? false;

    const factor = UNITS[einheit];
    if (!factor) {
      await interaction.reply({ content: '❌ Unbekannte Zeiteinheit.', flags: MessageFlags.Ephemeral });
      return;
    }
    const ms = dauer * factor;
    if (ms < MIN_DURATION_MS) {
      await interaction.reply({ content: '❌ Mindestdauer: 5 Sekunden.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (ms > MAX_DURATION_MS) {
      await interaction.reply({ content: '❌ Maximaldauer: 1 Jahr.', flags: MessageFlags.Ephemeral });
      return;
    }
    if (recurring && ms < MIN_RECURRENCE_MS) {
      await interaction.reply({ content: '❌ Wiederkehrende Reminder: min. 1 Minute Abstand.', flags: MessageFlags.Ephemeral });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    // Channel-Mode nur in Server-Text-Channels
    let channelId: string | null = null;
    if (zielArg === 'channel') {
      if (!interaction.guildId || !interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
        await interaction.editReply({
          embeds: [buildStatusEmbed({
            status: 'WARNING',
            title: 'Channel-Zustellung nicht möglich',
            description: 'Channel-Zustellung nur in Server-Text-Channels. Falle zurück auf DM.',
            footerText: Brand.footerText,
          })],
        });
      } else {
        channelId = interaction.channelId;
      }
    }

    // Pro-User-Limit
    const active = await prisma.reminder.count({ where: { userId: interaction.user.id, isActive: true } });
    if (active >= MAX_PER_USER) {
      await interaction.editReply({
        embeds: [buildStatusEmbed({
          status: 'ERROR',
          title: 'Reminder-Limit erreicht',
          description: `Maximal ${MAX_PER_USER} aktive Reminder pro User.`,
          footerText: Brand.footerText,
        })],
      });
      return;
    }

    const dueAt = new Date(Date.now() + ms);
    const r = await prisma.reminder.create({
      data: {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId,
        message: text,
        dueAt,
        isRecurring: recurring,
        recurrenceMs: recurring ? ms : null,
      },
    });
    logAudit('REMINDER_CREATED', 'USER', { reminderId: r.id, userId: interaction.user.id, ms, recurring });

    const targetLabel = channelId ? `<#${channelId}>` : 'per DM';
    await interaction.editReply({
      embeds: [buildStatusEmbed({
        status: 'SUCCESS',
        title: 'Erinnerung gesetzt',
        description: [
          `**Wann:** <t:${Math.floor(dueAt.getTime() / 1000)}:R> (<t:${Math.floor(dueAt.getTime() / 1000)}:F>)`,
          `**Wo:** ${targetLabel}`,
          recurring ? `**Wiederholt:** alle ${dauer} ${einheit}` : '',
          `**Text:** ${text}`,
          `**ID:** \`${r.id}\``,
        ].filter(Boolean).join('\n'),
        footerText: Brand.footerText,
      })],
    });
    return;
  }

  if (sub === 'liste') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const list = await prisma.reminder.findMany({
      where: { userId: interaction.user.id, isActive: true },
      orderBy: { dueAt: 'asc' },
      take: MAX_PER_USER,
    });
    const footer = list.length > 15
      ? `${Brand.footerText} • ${list.length - 15} weitere ausgeblendet`
      : Brand.footerText;
    const embed = compactEmbed(Colors.Info, footer)
      .setDescription(compactDescription(`⏰ Deine Erinnerungen (${list.length})`, [
        !list.length ? '_Keine aktiven Reminder. Setze einen mit `/erinnerung setzen`._' : null,
      ]));
    if (list.length) {
      for (const r of list.slice(0, 15)) {
        const ts = Math.floor(r.dueAt.getTime() / 1000);
        const wo = r.channelId ? `<#${r.channelId}>` : 'DM';
        const recur = r.isRecurring ? ' • 🔁' : '';
        embed.addFields({
          name: `\`${r.id}\`${recur}`,
          value: `<t:${ts}:R> • ${wo}\n${r.message.slice(0, 200)}`,
          inline: false,
        });
      }
    }
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  if (sub === 'loeschen') {
    const id = interaction.options.getString('id', true);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const r = await prisma.reminder.findUnique({ where: { id } });
    if (!r || r.userId !== interaction.user.id) {
      await interaction.editReply({
        embeds: [buildStatusEmbed({
          status: 'ERROR',
          title: 'Reminder nicht gefunden',
          description: 'Reminder nicht gefunden oder gehört dir nicht.',
          footerText: Brand.footerText,
        })],
      });
      return;
    }
    await prisma.reminder.update({ where: { id }, data: { isActive: false } });
    logAudit('REMINDER_DELETED', 'USER', { reminderId: id, userId: interaction.user.id });
    await interaction.editReply({
      embeds: [buildStatusEmbed({
        status: 'SUCCESS',
        title: 'Erinnerung deaktiviert',
        description: `Erinnerung \`${id}\` deaktiviert.`,
        footerText: Brand.footerText,
      })],
    });
    return;
  }
}

export default reminderCommand;
