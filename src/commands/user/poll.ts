/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
import {
  MessageFlags,
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import {
  createPoll,
  createPollEmbed,
  votePoll,
  endPoll,
  getPollVotes,
  PollOption,
  DEFAULT_EMOJIS,
} from '../../modules/polls/pollSystem';
import { grantEventXp } from '../../modules/xp/xpManager';
import { Colors, Brand, vEmbed, percentBar } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';
import { safeSend } from '../../utils/safeSend';
import { logger } from '../../utils/logger';

const pollCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Umfragen und Abstimmungen erstellen und verwalten')
    .addSubcommand(sub => sub
      .setName('erstellen')
      .setDescription('Neue Umfrage erstellen')
      .addStringOption(opt => opt.setName('titel').setDescription('Titel der Umfrage').setRequired(true))
      .addStringOption(opt => opt.setName('optionen').setDescription('Optionen (kommagetrennt, max 10)').setRequired(true))
      .addStringOption(opt => opt.setName('beschreibung').setDescription('Beschreibung der Umfrage').setRequired(false))
      .addStringOption(opt => opt.setName('typ').setDescription('Umfrage-Typ').setRequired(false).addChoices(
        { name: 'Öffentlich', value: 'PUBLIC' },
        { name: 'Anonym', value: 'ANONYMOUS' },
      ))
      .addBooleanOption(opt => opt.setName('mehrfach').setDescription('Mehrfachauswahl erlauben?').setRequired(false))
      .addIntegerOption(opt => opt.setName('max-stimmen').setDescription('Max. Stimmen pro User').setRequired(false).setMinValue(1).setMaxValue(10))
      .addIntegerOption(opt => opt.setName('dauer').setDescription('Dauer der Umfrage').setRequired(false).setMinValue(1))
      .addStringOption(opt => opt.setName('dauer-einheit').setDescription('Einheit der Dauer').setRequired(false).addChoices(
        { name: 'Minuten', value: 'minutes' },
        { name: 'Stunden', value: 'hours' },
        { name: 'Tage', value: 'days' },
        { name: 'Wochen', value: 'weeks' },
      ))
      .addRoleOption(opt => opt.setName('benachrichtigungs-rolle').setDescription('Rolle die bei Beendigung gepingt wird (optional)').setRequired(false)),
    )
    .addSubcommand(sub => sub
      .setName('abstimmen')
      .setDescription('Für eine Option abstimmen')
      .addStringOption(opt => opt.setName('poll-id').setDescription('Umfrage-ID').setRequired(true))
      .addIntegerOption(opt => opt.setName('option').setDescription('Optionsnummer (1-10)').setRequired(true).setMinValue(1).setMaxValue(10)),
    )
    .addSubcommand(sub => sub
      .setName('ergebnis')
      .setDescription('Aktuelle Ergebnisse anzeigen')
      .addStringOption(opt => opt.setName('poll-id').setDescription('Umfrage-ID').setRequired(true)),
    )
    .addSubcommand(sub => sub
      .setName('beenden')
      .setDescription('Umfrage manuell beenden')
      .addStringOption(opt => opt.setName('poll-id').setDescription('Umfrage-ID').setRequired(true)),
    )
    .addSubcommand(sub => sub.setName('liste').setDescription('Aktive Umfragen anzeigen')),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const sub = interaction.options.getSubcommand();
    try {
      await runPollSubcommand(sub, interaction);
    } catch (error) {
      logger.error(`/poll ${sub} fehlgeschlagen:`, error as Error);
      const embed = vEmbed(Colors.Error)
        .setTitle('Poll-Aktion fehlgeschlagen')
        .setDescription('Ein interner Fehler ist aufgetreten. Bitte versuche es erneut.');
      try {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds: [embed] });
        else await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      } catch { /* Interaction nicht mehr nutzbar */ }
    }
  },
};

async function runPollSubcommand(sub: string, interaction: ChatInputCommandInteraction): Promise<void> {
  switch (sub) {
    case 'erstellen': {
      await interaction.deferReply();
      const titel = interaction.options.getString('titel', true);
      const optionenStr = interaction.options.getString('optionen', true);
      const beschreibung = interaction.options.getString('beschreibung');
      const typ = (interaction.options.getString('typ') || 'PUBLIC') as 'PUBLIC' | 'ANONYMOUS';
      const mehrfach = interaction.options.getBoolean('mehrfach') || false;
      const maxStimmen = interaction.options.getInteger('max-stimmen') || 1;
      const dauerWert = interaction.options.getInteger('dauer') || null;
      const dauerEinheit = interaction.options.getString('dauer-einheit') || 'minutes';
      const notifyRole = interaction.options.getRole('benachrichtigungs-rolle');

      let dauer: number | null = null;
      if (dauerWert) {
        const multipliers: Record<string, number> = {
          minutes: 1,
          hours: 60,
          days: 60 * 24,
          weeks: 60 * 24 * 7,
        };
        dauer = dauerWert * (multipliers[dauerEinheit] || 1);
      }

      const optionen = optionenStr.split(',').map(option => option.trim()).filter(Boolean);
      if (optionen.length < 2 || optionen.length > 10) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Ungueltige Optionen').setDescription('Bitte 2 bis 10 Optionen kommagetrennt angeben.')] });
        return;
      }

      const dbUser = await prisma.user.upsert({
        where: { discordId: interaction.user.id },
        create: { discordId: interaction.user.id, username: interaction.user.username },
        update: {},
      });
      if (!interaction.guildId) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Server-Kontext erforderlich').setDescription('Dieser Befehl ist nur auf einem Server verfuegbar.')] });
        return;
      }

      const { pollId, options } = await createPoll(
        dbUser.id,
        interaction.channelId,
        interaction.guildId,
        titel,
        beschreibung,
        optionen,
        typ,
        mehrfach,
        maxStimmen,
        dauer,
        notifyRole?.id || null,
      );

      const endsAt = dauer ? new Date(Date.now() + dauer * 60 * 1000) : null;
      const initialVotes: Record<string, number> = {};
      for (const option of options) initialVotes[option.id] = 0;
      const embed = createPollEmbed(titel, beschreibung, options, typ, endsAt, initialVotes, 0);
      embed.setFooter({ text: `Poll-ID: ${pollId} | Klicke einen Button um abzustimmen` });

      const rows: ActionRowBuilder<ButtonBuilder>[] = [];
      for (let rowIdx = 0; rowIdx < Math.ceil(options.length / 5); rowIdx++) {
        const row = new ActionRowBuilder<ButtonBuilder>();
        for (const option of options.slice(rowIdx * 5, rowIdx * 5 + 5)) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`poll_vote_${pollId}_${option.id}`)
              .setLabel(option.text.slice(0, 80))
              .setEmoji(option.emoji)
              .setStyle(ButtonStyle.Primary),
          );
        }
        rows.push(row);
      }

      const message = await interaction.editReply({ embeds: [embed], components: rows });
      await prisma.poll.update({ where: { id: pollId }, data: { messageId: message.id } });
      break;
    }

    case 'abstimmen': {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const pollId = interaction.options.getString('poll-id', true);
      const optionNum = interaction.options.getInteger('option', true);
      const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
      if (!dbUser) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Nicht registriert').setDescription('Dein Benutzerkonto ist noch nicht registriert.')] });
        return;
      }
      if (!interaction.guildId) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Server-Kontext erforderlich').setDescription('Dieser Befehl ist nur auf einem Server verfuegbar.')] });
        return;
      }

      const result = await votePoll(pollId, dbUser.id, `opt_${optionNum - 1}`, interaction.guildId);
      await interaction.editReply({
        embeds: [vEmbed(result.success ? Colors.Success : Colors.Error)
          .setTitle(result.success ? 'Stimme gespeichert' : 'Abstimmung nicht moeglich')
          .setDescription(result.message)],
      });

      if (result.success) {
        try { await grantEventXp(dbUser.id, interaction.guildId, 5, 'POLL_VOTE', pollId); } catch { /* nicht kritisch */ }
        const poll = await prisma.poll.findFirst({ where: { id: pollId, guildId: interaction.guildId } });
        if (poll?.messageId) {
          try {
            const channel = await interaction.client.channels.fetch(poll.channelId);
            if (channel && 'messages' in channel) {
              const message = await (channel as any).messages.fetch(poll.messageId);
              const votes = await getPollVotes(pollId);
              const options = poll.options as unknown as PollOption[];
              const totalVotes = Object.values(votes).reduce((sum, count) => sum + count, 0);
              const embed = createPollEmbed(poll.title, poll.description, options, poll.pollType, poll.endsAt, votes, totalVotes);
              embed.setFooter({ text: `Poll-ID: ${pollId} ${Brand.dot} ${Brand.footerText}` });
              await message.edit({ embeds: [embed] });
            }
          } catch { /* UI-Spiegelung nicht kritisch */ }
        }
      }
      break;
    }

    case 'ergebnis': {
      await interaction.deferReply();
      if (!interaction.guildId) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Server-Kontext erforderlich').setDescription('Dieser Befehl ist nur auf einem Server verfuegbar.')] });
        return;
      }
      const pollId = interaction.options.getString('poll-id', true);
      const poll = await prisma.poll.findFirst({ where: { id: pollId, guildId: interaction.guildId } });
      if (!poll) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Umfrage nicht gefunden').setDescription('Die angegebene Poll-ID existiert auf diesem Server nicht.')] });
        return;
      }

      const votes = await getPollVotes(pollId);
      const options = poll.options as unknown as PollOption[];
      const totalVotes = Object.values(votes).reduce((sum, count) => sum + count, 0);
      const optionLines = options.map((option, index) => {
        const percentage = totalVotes > 0 ? Math.round((votes[option.id] || 0) / totalVotes * 100) : 0;
        return `${DEFAULT_EMOJIS[index]} ${option.text}\n┃ ${percentBar(percentage, 10)}  **${percentage}%** (${votes[option.id] || 0} Stimmen)`;
      });
      const embed = createBotEmbed({
        title: poll.status === 'ENDED' ? `📊 Umfrage beendet: ${poll.title}` : `📊 ${poll.title}`,
        description: [
          poll.description ? `> ${poll.description}` : undefined,
          Brand.divider,
          optionLines.join('\n\n'),
          Brand.divider,
          `Gesamtstimmen: **${totalVotes}**`,
          `Poll-ID: \`${pollId}\``,
        ].filter(Boolean).join('\n'),
        color: poll.status === 'ENDED' ? Colors.Neutral : Colors.Poll,
        footer: `${Brand.footerText} • Poll`,
        timestamp: true,
      });
      await interaction.editReply({ embeds: [embed] });
      break;
    }

    case 'beenden': {
      await interaction.deferReply();
      if (!interaction.guildId) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Server-Kontext erforderlich').setDescription('Dieser Befehl ist nur auf einem Server verfuegbar.')] });
        return;
      }

      const pollId = interaction.options.getString('poll-id', true);
      const poll = await prisma.poll.findFirst({ where: { id: pollId, guildId: interaction.guildId } });
      if (!poll) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Umfrage nicht gefunden').setDescription('Die angegebene Poll-ID existiert auf diesem Server nicht.')] });
        return;
      }
      const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
      if (poll.creatorId !== dbUser?.id && !interaction.memberPermissions?.has('Administrator')) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Keine Berechtigung').setDescription('Nur der Ersteller oder Administratoren koennen diese Umfrage beenden.')] });
        return;
      }

      await endPoll(pollId, interaction.guildId, async result => {
        const resultLines = result.results.map((entry, index) => {
          const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `**${index + 1}.**`;
          return `${medal} **${entry.option}**\n┃ ${percentBar(entry.percentage, 10)}  **${entry.percentage}%** (${entry.votes} Stimmen)`;
        });
        const embed = vEmbed(Colors.Success)
          .setTitle(`Umfrage beendet: ${result.title}`)
          .setDescription(`${Brand.divider}\n\n${resultLines.join('\n\n')}\n\n${Brand.divider}`)
          .addFields(
            { name: '🏆 Gewinner', value: `**${result.winner}**`, inline: true },
            { name: '🗳️ Stimmen', value: `**${result.totalVotes}**`, inline: true },
          );

        // Die sichtbare Abschlussmeldung ist kritisch. Scheitert sie, darf die
        // DB den Poll nicht als ENDED finalisieren.
        await interaction.editReply({ embeds: [embed] });

        // Der Rollen-Ping ist zusaetzliche Benachrichtigung, nicht Teil der
        // Poll-Wahrheit. Ein Discord-Fehler hier darf einen bereits sichtbar
        // bestaetigten Abschluss nicht wieder auf ACTIVE zurueckrollen.
        if (poll.notifyRoleId && interaction.channel && 'send' in interaction.channel) {
          const sent = await safeSend(interaction.channel, {
            content: `<@&${poll.notifyRoleId}> 📊 Umfrage **${result.title}** wurde beendet!`,
            allowedMentions: { roles: [poll.notifyRoleId], parse: [] },
          });
          if (!sent) {
            logger.warn('Poll-Benachrichtigung konnte nicht zugestellt werden.', {
              pollId,
              roleId: poll.notifyRoleId,
            });
          }
        }

        if (poll.messageId && interaction.channel && 'messages' in interaction.channel) {
          try {
            const message = await (interaction.channel as any).messages.fetch(poll.messageId);
            await message.edit({ embeds: [embed], components: [] });
          } catch { /* optionale UI-Spiegelung */ }
        }
      });
      break;
    }

    case 'liste': {
      await interaction.deferReply();
      if (!interaction.guildId) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Error).setTitle('Server-Kontext erforderlich').setDescription('Dieser Befehl ist nur auf einem Server verfuegbar.')] });
        return;
      }

      const polls = await prisma.poll.findMany({
        where: { status: 'ACTIVE', guildId: interaction.guildId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      if (polls.length === 0) {
        await interaction.editReply({ embeds: [vEmbed(Colors.Info).setTitle('Aktive Umfragen').setDescription('Aktuell gibt es keine aktiven Umfragen.')] });
        return;
      }

      const fields = polls.map(poll => ({
        name: `📊 ${poll.title}`,
        value: [
          `🗳️ ${poll.totalVotes} Stimmen`,
          `⏰ ${poll.endsAt ? `<t:${Math.floor(poll.endsAt.getTime() / 1000)}:R>` : '∞'}`,
          `ID: \`${poll.id}\``,
        ].join(' | '),
        inline: false,
      }));
      await interaction.editReply({
        embeds: [createBotEmbed({
          title: '📊 Aktive Umfragen',
          color: Colors.Poll,
          fields,
          footer: `${Brand.footerText} • Poll`,
          timestamp: true,
        })],
      });
      break;
    }
  }
}

export default pollCommand;
