import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command, ExtendedClient } from '../../types';
import { visibleCommandCatalog, type CommandCatalogEntry } from '../catalog';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';

const PAGE_SIZE = 14;

type HelpCategory = 'overview' | 'moderation' | 'nitrado' | 'economy' | 'manufacturer' | 'community';

interface CategoryDefinition {
  id: Exclude<HelpCategory, 'overview'>;
  label: string;
  emoji: string;
  description: string;
  names: ReadonlySet<string>;
}

const CATEGORIES: readonly CategoryDefinition[] = [
  {
    id: 'moderation',
    label: 'Moderation',
    emoji: '🛡️',
    description: 'Discord-Moderation, Sanktionen und Einsprueche.',
    names: new Set(['kick', 'ban', 'mute', 'warn', 'appeal']),
  },
  {
    id: 'nitrado',
    label: 'Nitrado',
    emoji: '🎮',
    description: 'Whitelist, Gameserver-Bans und delegierte Server-Berechtigungen.',
    names: new Set([
      'whitelist-antrag', 'whitelist-add', 'whitelist-remove', 'whitelist',
      'server-ban', 'server-unban', 'server-ban-list',
      'perm-add', 'perm-remove', 'perms',
    ]),
  },
  {
    id: 'economy',
    label: 'Economy · Bank · Casino · Verknuepfung',
    emoji: '💰',
    description: 'Wallet/Bank, Transfers, DayZ-Verknuepfung und Casino.',
    names: new Set([
      'balance', 'bank', 'pay', 'deposit', 'withdraw', 'transfer',
      'link', 'unlink',
      'slot', 'coinflip', 'dice', 'blackjack', 'casino-stats',
    ]),
  },
  {
    id: 'manufacturer',
    label: 'Hersteller',
    emoji: '🏭',
    description: 'Hersteller-Verifikation, Pakete, Uploads und Downloads.',
    names: new Set(['register', 'upload', 'mypackages', 'search', 'download']),
  },
  {
    id: 'community',
    label: 'Community & Tools',
    emoji: '👥',
    description: 'Polls, Giveaways, Tickets, XP, Fraktionen, Reminder und weitere Nutzerfunktionen.',
    names: new Set([
      'help', 'stell-dich-vor', 'feedback', 'erinnerung',
      'level', 'leaderboard', 'giveaway', 'poll', 'ticket',
      'fraktionen', 'factions', 'faction', 'join', 'leave',
    ]),
  },
] as const;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function categoryFor(entry: CommandCatalogEntry): CategoryDefinition {
  return CATEGORIES.find(category => category.names.has(entry.name)) ?? CATEGORIES[CATEGORIES.length - 1];
}

function entriesFor(entries: CommandCatalogEntry[], category: HelpCategory): CommandCatalogEntry[] {
  if (category === 'overview') return entries;
  return entries.filter(entry => categoryFor(entry).id === category);
}

function overviewEmbed(entries: CommandCatalogEntry[]): EmbedBuilder {
  const embed = vEmbed(Colors.Primary)
    .setTitle('V-Bot Prime · Command-Hilfe')
    .setDescription(
      'Die sichtbaren Discord-Commands sind nach Funktionsbereich geordnet. ' +
      '**DEV-Funktionen und `/ai` werden hier bewusst nicht angezeigt.**\n\n' +
      `${Brand.divider}`,
    );

  // Reihenfolge ist Produktvorgabe: Moderation -> Nitrado -> Economy -> Hersteller.
  for (const category of CATEGORIES) {
    const commands = entries
      .filter(entry => categoryFor(entry).id === category.id)
      .map(entry => `\`/${entry.name}\``);
    if (commands.length === 0) continue;
    embed.addFields({
      name: `${category.emoji} ${category.label}`,
      value: `${category.description}\n${commands.join(' · ')}`.slice(0, 1024),
      inline: false,
    });
  }

  return embed.setFooter({ text: 'Kategorie waehlen fuer Beschreibungen · DEV & /ai bleiben unsichtbar' });
}

function categoryEmbed(
  entries: CommandCatalogEntry[],
  category: Exclude<HelpCategory, 'overview'>,
  page: number,
  totalPages: number,
): EmbedBuilder {
  const definition = CATEGORIES.find(item => item.id === category) ?? CATEGORIES[CATEGORIES.length - 1];
  const start = page * PAGE_SIZE;
  const chunk = entries.slice(start, start + PAGE_SIZE);
  const body = chunk.length
    ? chunk.map(entry => {
      const manufacturerBadge = entry.audience === 'manufacturer' ? ' 🔒' : '';
      return `**\`/${entry.name}\`**${manufacturerBadge}\n${truncate(entry.description || 'Keine Beschreibung.', 180)}`;
    }).join('\n\n')
    : '_Keine sichtbaren Commands in dieser Kategorie._';

  return vEmbed(Colors.Primary)
    .setTitle(`${definition.emoji} ${definition.label}`)
    .setDescription(
      `${definition.description}\n\n${Brand.divider}\n\n${body}\n\n${Brand.divider}\n` +
      `Seite **${page + 1}/${totalPages}** · ${entries.length} Commands`,
    )
    .setFooter({ text: '🔒 erfordert verifizierten Herstellerstatus · DEV & /ai nicht gelistet' });
}

function buttons(page: number, totalPages: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('help_prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(page <= 0),
    new ButtonBuilder().setCustomId('help_next').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(page >= totalPages - 1),
  );
}

const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Zeigt die strukturierten, oeffentlich freigegebenen Discord-Commands.')
    .addStringOption(option => option
      .setName('category')
      .setDescription('Funktionsbereich anzeigen')
      .setRequired(false)
      .addChoices(
        { name: 'Uebersicht', value: 'overview' },
        { name: 'Moderation', value: 'moderation' },
        { name: 'Nitrado', value: 'nitrado' },
        { name: 'Economy · Bank · Casino · Verknuepfung', value: 'economy' },
        { name: 'Hersteller', value: 'manufacturer' },
        { name: 'Community & Tools', value: 'community' },
      )),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const client = interaction.client as ExtendedClient;

    // Manufacturer-Commands duerfen in der Hilfe auffindbar sein; ihre echte
    // Nutzung bleibt weiterhin durch manufacturerOnly hart abgesichert.
    const visible = visibleCommandCatalog(client, {
      isAdmin: false,
      isDeveloper: false,
      isManufacturer: true,
    });

    const requested = (interaction.options.getString('category') ?? 'overview') as HelpCategory;
    if (requested === 'overview') {
      await interaction.editReply({ embeds: [overviewEmbed(visible)], components: [] });
      return;
    }

    const entries = entriesFor(visible, requested);
    const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    let page = 0;
    const message = await interaction.editReply({
      embeds: [categoryEmbed(entries, requested, page, totalPages)],
      components: totalPages > 1 ? [buttons(page, totalPages)] : [],
    });

    if (totalPages <= 1) return;
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: component => component.user.id === interaction.user.id,
    });
    collector.on('collect', async component => {
      if (component.customId === 'help_prev') page = Math.max(0, page - 1);
      if (component.customId === 'help_next') page = Math.min(totalPages - 1, page + 1);
      await component.update({
        embeds: [categoryEmbed(entries, requested, page, totalPages)],
        components: [buttons(page, totalPages)],
      });
    });
    collector.on('end', () => {
      void interaction.editReply({ components: [] }).catch(() => undefined);
    });
  },
};

export default helpCommand;
