import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
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

/**
 * /poll Command (Sektion 10):
 * - Schnelle Umfragen und Abstimmungen per Command
 * - Anonyme oder öffentliche Votes, Mehrfachauswahl, Zeitlimit
 * - Ergebnisse als Live-Embed
 * - Automatische Auswertung
 */
const pollCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Umfragen und Abstimmungen erstellen und verwalten')
    .addSubcommand(sub =>
      sub
        .setName('erstellen')
        .setDescription('Neue Umfrage erstellen')
        .addStringOption(opt =>
          opt.setName('titel').setDescription('Titel der Umfrage').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('optionen').setDescription('Optionen (kommagetrennt, max 10)').setRequired(true)
        )
        .addStringOption(opt =>
          opt.setName('beschreibung').setDescription('Beschreibung der Umfrage').setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName('typ')
            .setDescription('Umfrage-Typ')
            .setRequired(false)
            .addChoices(
              { name: 'Öffentlich', value: 'PUBLIC' },
              { name: 'Anonym', value: 'ANONYMOUS' },
            )
        )
        .addBooleanOption(opt =>
          opt.setName('mehrfach').setDescription('Mehrfachauswahl erlauben?').setRequired(false)
        )
        .addIntegerOption(opt =>
          opt.setName('max-stimmen').setDescription('Max. Stimmen pro User').setRequired(false).setMinValue(1).setMaxValue(10)
        )
        .addIntegerOption(opt =>
          opt.setName('dauer').setDescription('Dauer der Umfrage').setRequired(false).setMinValue(1)
        )
        .addStringOption(opt =>
          opt
            .setName('dauer-einheit')
            .setDescription('Einheit der Dauer')
            .setRequired(false)
            .addChoices(
              { name: 'Minuten', value: 'minutes' },
              { name: 'Stunden', value: 'hours' },
              { name: 'Tage', value: 'days' },
              { name: 'Wochen', value: 'weeks' },
            )
        )
        .addRoleOption(opt =>
          opt.setName('benachrichtigungs-rolle').setDescription('Rolle die bei Beendigung gepingt wird (optional)').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('abstimmen')
        .setDescription('Für eine Option abstimmen')
        .addStringOption(opt =>
          opt.setName('poll-id').setDescription('Umfrage-ID').setRequired(true)
        )
        .addIntegerOption(opt =>
          opt.setName('option').setDescription('Optionsnummer (1-10)').setRequired(true).setMinValue(1).setMaxValue(10)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('ergebnis')
        .setDescription('Aktuelle Ergebnisse anzeigen')
        .addStringOption(opt =>
          opt.setName('poll-id').setDescription('Umfrage-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('beenden')
        .setDescription('Umfrage manuell beenden')
        .addStringOption(opt =>
          opt.setName('poll-id').setDescription('Umfrage-ID').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('liste')
        .setDescription('Aktive Umfragen anzeigen')
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const sub = interaction.options.getSubcommand();

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

        // Dauer in Minuten umrechnen
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

        const optionen = optionenStr.split(',').map(o => o.trim()).filter(o => o.length > 0);
        if (optionen.length < 2 || optionen.length > 10) {
          await interaction.editReply({ content: '❌ Bitte 2 bis 10 Optionen angeben (kommagetrennt).' });
          return;
        }

        // User erstellen falls nötig
        await prisma.user.upsert({
          where: { discordId: interaction.user.id },
          create: { discordId: interaction.user.id, username: interaction.user.username },
          update: {},
        });

        const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
        if (!dbUser) {
          await interaction.editReply({ content: '❌ Interner Fehler.' });
          return;
        }

        const { pollId, options } = await createPoll(
          dbUser.id,
          interaction.channelId,
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
        // Neues Embed-Design mit createBotEmbed
        const embed = createBotEmbed({
          title: `📊 ${titel}`,
          description: [
            beschreibung ? `> ${beschreibung}` : undefined,
            Brand.divider,
            options.map((opt, i) => `${DEFAULT_EMOJIS[i]} ${opt}`).join('\n'),
            Brand.divider,
            endsAt ? `⏰ Endet: <t:${Math.floor(endsAt.getTime() / 1000)}:R>` : '⏰ Kein Zeitlimit',
            `Poll-ID: \`${pollId}\``,
          ].filter(Boolean).join('\n'),
          color: Colors.Poll,
          footer: `${Brand.footerText} • Poll`,
          timestamp: true,
        });
        const msg = await interaction.editReply({ embeds: [embed] });

        // Message-ID speichern + Reaktionen hinzufügen
        await prisma.poll.update({
          where: { id: pollId },
          data: { messageId: msg.id },
        });

        // Reaktionen für Optionen hinzufügen
        for (const opt of options) {
          try {
            await msg.react(opt.emoji);
          } catch { /* Emoji might not be available */ }
        }
        break;
      }

      case 'abstimmen': {
        await interaction.deferReply({ ephemeral: true });

        const pollId = interaction.options.getString('poll-id', true);
        const optionNum = interaction.options.getInteger('option', true);

        const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
        if (!dbUser) {
          await interaction.editReply({ content: '❌ Du bist nicht registriert.' });
          return;
        }

        const optionId = `opt_${optionNum - 1}`;
        const result = await votePoll(pollId, dbUser.id, optionId);

        await interaction.editReply({ content: result.success ? `✅ ${result.message}` : `❌ ${result.message}` });

        // Event-XP für Abstimmung vergeben (Sektion 8: Event-XP)
        if (result.success) {
          try {
            await grantEventXp(dbUser.id, 5, 'POLL_VOTE', pollId);
          } catch { /* XP-Vergabe nicht kritisch */ }
        }

        // Live-Embed updaten
        if (result.success) {
          const poll = await prisma.poll.findUnique({ where: { id: pollId } });
          if (poll?.messageId) {
            try {
              const channel = await interaction.client.channels.fetch(poll.channelId);
              if (channel && 'messages' in channel) {
                const msg = await (channel as any).messages.fetch(poll.messageId);
                const votes = await getPollVotes(pollId);
                const options = poll.options as unknown as PollOption[];
                const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);
                const embed = createPollEmbed(
                  poll.title, poll.description, options, poll.pollType,
                  poll.endsAt, votes, totalVotes,
                );
                embed.setFooter({ text: `Poll-ID: ${pollId} ${Brand.dot} ${Brand.footerText}` });
                await msg.edit({ embeds: [embed] });
              }
            } catch { /* Could not update embed */ }
          }
        }
        break;
      }

      case 'ergebnis': {
        await interaction.deferReply();

        const pollId = interaction.options.getString('poll-id', true);
        const poll = await prisma.poll.findUnique({ where: { id: pollId } });

        if (!poll) {
          await interaction.editReply({ content: '❌ Umfrage nicht gefunden.' });
          return;
        }

        const votes = await getPollVotes(pollId);
        const options = poll.options as unknown as PollOption[];
        const totalVotes = Object.values(votes).reduce((a, b) => a + b, 0);

        // Neues Embed-Design mit createBotEmbed
        const optionLines = options.map((opt, i) => {
          const pct = totalVotes > 0 ? Math.round((votes[opt.id] || 0) / totalVotes * 100) : 0;
          const bar = percentBar(pct, 10);
          return `${DEFAULT_EMOJIS[i]} ${opt.text}\n┃ ${bar}  **${pct}%** (${votes[opt.id] || 0} Stimmen)`;
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

        const pollId = interaction.options.getString('poll-id', true);
        const poll = await prisma.poll.findUnique({ where: { id: pollId } });

        if (!poll) {
          await interaction.editReply({ content: '❌ Umfrage nicht gefunden.' });
          return;
        }

        // Nur Ersteller oder Admins dürfen beenden
        const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
        if (poll.creatorId !== dbUser?.id && !interaction.memberPermissions?.has('Administrator')) {
          await interaction.editReply({ content: '❌ Nur der Ersteller oder Admins können Umfragen beenden.' });
          return;
        }

        const result = await endPoll(pollId);
        const resultLines = result.results.map((r, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `**${i + 1}.**`;
          const bar = percentBar(r.percentage, 10);
          return `${medal} **${r.option}**\n┃ ${bar}  **${r.percentage}%** (${r.votes} Stimmen)`;
        });

        const embed = vEmbed(Colors.Success)
          .setTitle(`📊  Umfrage beendet: ${result.title}`)
          .setDescription(
            `${Brand.divider}\n\n` +
            resultLines.join('\n\n') +
            `\n\n${Brand.divider}`
          )
          .addFields(
            { name: '🏆 Gewinner', value: `**${result.winner}**`, inline: true },
            { name: '🗳️ Stimmen', value: `**${result.totalVotes}**`, inline: true },
          );

        // Rollen-Ping bei manueller Beendigung als separate Nachricht
        if (poll.notifyRoleId && interaction.channel && 'send' in interaction.channel) {
          await interaction.channel.send({
            content: `<@&${poll.notifyRoleId}> 📊 Umfrage **${result.title}** wurde beendet!`,
          });
        }

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'liste': {
        await interaction.deferReply();

        const polls = await prisma.poll.findMany({
          where: { status: 'ACTIVE' },
          orderBy: { createdAt: 'desc' },
          take: 10,
        });

        if (polls.length === 0) {
          await interaction.editReply({ content: '📋 Keine aktiven Umfragen.' });
          return;
        }

        const fields = polls.map((p: any, i: number) => {
          const end = p.endsAt ? `<t:${Math.floor(p.endsAt.getTime() / 1000)}:R>` : '∞';
          return {
            name: `📊 ${p.title}`,
            value: [
              `🗳️ ${p.totalVotes} Stimmen`,
              `⏰ ${end}`,
              `ID: \`${p.id}\``,
            ].join(' | '),
            inline: false,
          };
        });
        const embed = createBotEmbed({
          title: '📊 Aktive Umfragen',
          color: Colors.Poll,
          fields,
          footer: `${Brand.footerText} • Poll`,
          timestamp: true,
        });
        await interaction.editReply({ embeds: [embed] });
        break;
      }
    }
  },
};

export default pollCommand;
