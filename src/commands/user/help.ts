import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionsBitField,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Command, ExtendedClient } from '../../types';
import { visibleCommandCatalog, type CommandCatalogEntry } from '../catalog';
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';

type HelpCategory = 'overview' | 'moderation' | 'nitrado' | 'economy' | 'manufacturer' | 'community' | 'other';

type JsonOption = {
  type: number;
  name: string;
  description?: string;
  required?: boolean;
  options?: JsonOption[];
};

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
    names: new Set(['kick', 'ban', 'mute', 'warn', 'appeal', 'case']),
  },
  {
    id: 'nitrado',
    label: 'Nitrado',
    emoji: '🎮',
    description: 'Whitelist, Gameserver-Bans und delegierte Server-Berechtigungen.',
    names: new Set([
      'whitelist-antrag', 'whitelist-add', 'whitelist-remove',
      'server-ban', 'server-unban',
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
      'link', 'unlink', 'links', 'link-info', 'link-panel',
      'force-link', 'force-unlink', 'confirm-action',
      'slot', 'coinflip', 'dice', 'blackjack', 'casino-stats',
      'virtual-account', 'lottery', 'black-market',
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
  {
    id: 'other',
    label: 'Weitere Funktionen',
    emoji: '🧭',
    description: 'Sichtbare Funktionen, die noch keinem festen Bereich zugeordnet sind.',
    names: new Set(),
  },
] as const;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function categoryFor(entry: CommandCatalogEntry): CategoryDefinition {
  return CATEGORIES.find(category => category.names.has(entry.name)) ?? CATEGORIES.find(category => category.id === 'other')!;
}

function entriesFor(entries: CommandCatalogEntry[], category: HelpCategory): CommandCatalogEntry[] {
  if (category === 'overview') return entries;
  return entries.filter(entry => categoryFor(entry).id === category);
}

function overviewEmbed(_entries: CommandCatalogEntry[]): EmbedBuilder {
  return vEmbed(Colors.Primary)
    .setTitle('👋 Willkommen bei V-Bot Prime')
    .setDescription(
      'Hier findest du die freigegebenen Funktionen von V-Bot – ohne eine lange Command-Wand.\n\n' +
      '**So funktioniert die Hilfe:**\n' +
      '1. Waehle unten zuerst einen Bereich aus.\n' +
      '2. Auf der Funktionsseite bringt dich **▶️ Weiter** zur naechsten Funktion.\n' +
      '3. Mit **◀️ Zurueck** gehst du wieder eine Funktion zurueck.\n' +
      '4. Mit **📚 Katalog** kommst du jederzeit hierher zurueck.\n\n' +
      `${Brand.divider}\n` +
      '_DEV-Funktionen und `/ai` bleiben bewusst ausserhalb dieser Nutzer-Hilfe._',
    )
    .setFooter({ text: 'Bereich auswaehlen · dann mit ◀️ / ▶️ durch die Funktionen navigieren' });
}

function optionToken(option: JsonOption): string {
  return option.required ? `<${option.name}>` : `[${option.name}]`;
}

function optionSuffix(options: JsonOption[] | undefined): string {
  const normal = (options ?? []).filter(option => option.type !== 1 && option.type !== 2);
  return normal.length ? ` ${normal.map(optionToken).join(' ')}` : '';
}

function syntaxLines(commandName: string, options: JsonOption[]): string[] {
  const lines: string[] = [];

  for (const option of options) {
    if (option.type === 1) {
      lines.push(`/${commandName} ${option.name}${optionSuffix(option.options)}`);
      continue;
    }
    if (option.type === 2) {
      const subcommands = (option.options ?? []).filter(child => child.type === 1);
      for (const subcommand of subcommands) {
        lines.push(`/${commandName} ${option.name} ${subcommand.name}${optionSuffix(subcommand.options)}`);
      }
    }
  }

  if (lines.length === 0) lines.push(`/${commandName}${optionSuffix(options)}`);
  return lines;
}

function parameterLines(options: JsonOption[], prefix = ''): string[] {
  const result: string[] = [];
  for (const option of options) {
    if (option.type === 1 || option.type === 2) {
      const scope = prefix ? `${prefix} ${option.name}` : option.name;
      if (option.description) result.push(`**${scope}** — ${option.description}`);
      result.push(...parameterLines(option.options ?? [], scope));
      continue;
    }

    const scope = prefix ? `${prefix} · ${option.name}` : option.name;
    const requirement = option.required ? 'Pflicht' : 'optional';
    result.push(`\`${scope}\` · ${requirement} — ${option.description || 'Keine Beschreibung.'}`);
  }
  return result;
}

function accessText(command: Command | undefined, entry: CommandCatalogEntry): string {
  const access = entry.audience === 'manufacturer'
    ? '🔒 Verifizierter Hersteller'
    : entry.audience === 'admin'
      ? '🛡️ Bot-Admin'
      : '🌐 Sichtbarer Nutzer-Command';

  if (!command?.permissions?.length) return access;
  const permissions = new PermissionsBitField(command.permissions).toArray();
  if (!permissions.length) return access;
  return `${access}\nDiscord-Berechtigung: ${permissions.map(permission => `\`${permission}\``).join(', ')}`;
}

function detailEmbed(
  client: ExtendedClient,
  entry: CommandCatalogEntry,
  index: number,
  total: number,
): EmbedBuilder {
  const definition = categoryFor(entry);
  const command = client.commands.get(entry.name);
  const json = command?.data.toJSON() as { options?: JsonOption[] } | undefined;
  const options = json?.options ?? [];
  const syntax = syntaxLines(entry.name, options).map(line => `\`${line}\``).join('\n');
  const parameters = parameterLines(options).join('\n');

  return vEmbed(Colors.Primary)
    .setTitle(`${definition.emoji} /${entry.name}`)
    .setDescription(`${entry.description || 'Keine Beschreibung vorhanden.'}\n\n${Brand.divider}`)
    .addFields(
      {
        name: '📁 Bereich',
        value: `${definition.label}\n${definition.description}`,
        inline: false,
      },
      {
        name: '⌨️ Verwendung',
        value: truncate(syntax, 1024),
        inline: false,
      },
      {
        name: '🧩 Parameter & Funktionen',
        value: parameters ? truncate(parameters, 1024) : '_Keine zusaetzlichen Parameter._',
        inline: false,
      },
      {
        name: '🔐 Zugriff',
        value: truncate(accessText(command, entry), 1024),
        inline: false,
      },
      {
        name: '⏱️ Cooldown',
        value: entry.cooldownSeconds && entry.cooldownSeconds > 0
          ? `${entry.cooldownSeconds} Sekunden`
          : 'Kein zusaetzlicher Command-Cooldown',
        inline: false,
      },
    )
    .setFooter({
      text: `Funktion ${index + 1}/${total} in ${definition.label} · DEV & /ai nicht gelistet`,
    });
}

function emptyCategoryEmbed(category: Exclude<HelpCategory, 'overview'>): EmbedBuilder {
  const definition = CATEGORIES.find(item => item.id === category) ?? CATEGORIES.find(item => item.id === 'other')!;
  return vEmbed(Colors.Primary)
    .setTitle(`${definition.emoji} ${definition.label}`)
    .setDescription(`${definition.description}\n\n_Aktuell sind in diesem Bereich keine sichtbaren Commands verfuegbar._`)
    .setFooter({ text: 'Andere Kategorie im Auswahlmenue waehlen' });
}

function categorySelect(selected: HelpCategory): ActionRowBuilder<StringSelectMenuBuilder> {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_category')
    .setPlaceholder('Kategorie waehlen')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('Uebersicht')
        .setValue('overview')
        .setEmoji('📚')
        .setDefault(selected === 'overview'),
      ...CATEGORIES.map(category => new StringSelectMenuOptionBuilder()
        .setLabel(truncate(category.label, 100))
        .setValue(category.id)
        .setEmoji(category.emoji)
        .setDefault(selected === category.id)),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function commandSelect(
  entries: CommandCatalogEntry[],
  selectedIndex: number,
): ActionRowBuilder<StringSelectMenuBuilder> {
  // Discord erlaubt maximal 25 Select-Optionen. Bei groesseren Kategorien
  // folgt das Menue automatisch dem aktuellen 25er-Fenster; Vor/Zurueck
  // navigiert trotzdem ueber die komplette Kategorie.
  const windowStart = Math.floor(selectedIndex / 25) * 25;
  const windowEntries = entries.slice(windowStart, windowStart + 25);
  const selected = entries[selectedIndex];
  const menu = new StringSelectMenuBuilder()
    .setCustomId('help_command')
    .setPlaceholder(selected ? `/${selected.name} · Funktion waehlen` : 'Funktion waehlen')
    .addOptions(windowEntries.map(entry => new StringSelectMenuOptionBuilder()
      .setLabel(truncate(`/${entry.name}`, 100))
      .setDescription(truncate(entry.description || 'Keine Beschreibung.', 100))
      .setValue(entry.name)
      .setDefault(entry.name === selected?.name)));
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(menu);
}

function navigationButtons(index: number, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('help_prev')
      .setLabel('Zurueck')
      .setEmoji('◀️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index <= 0),
    new ButtonBuilder()
      .setCustomId('help_home')
      .setLabel('Katalog')
      .setEmoji('📚')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('help_next')
      .setLabel('Weiter')
      .setEmoji('▶️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(index >= total - 1),
  );
}

const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Oeffnet den interaktiven Katalog der freigegebenen Discord-Funktionen.')
    .addStringOption(option => option
      .setName('category')
      .setDescription('Funktionsbereich direkt oeffnen')
      .setRequired(false)
      .addChoices(
        { name: 'Uebersicht', value: 'overview' },
        { name: 'Moderation', value: 'moderation' },
        { name: 'Nitrado', value: 'nitrado' },
        { name: 'Economy · Bank · Casino · Verknuepfung', value: 'economy' },
        { name: 'Hersteller', value: 'manufacturer' },
        { name: 'Community & Tools', value: 'community' },
        { name: 'Weitere Funktionen', value: 'other' },
      )),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const client = interaction.client as ExtendedClient;

    // Hersteller-Commands duerfen im Katalog auffindbar sein; die eigentliche
    // Ausfuehrung bleibt unveraendert durch manufacturerOnly abgesichert.
    const visible = visibleCommandCatalog(client, {
      isAdmin: false,
      isDeveloper: false,
      isManufacturer: true,
    });

    let category = (interaction.options.getString('category') ?? 'overview') as HelpCategory;
    let entries = entriesFor(visible, category);
    let index = 0;

    const render = () => {
      if (category === 'overview') {
        return {
          embeds: [overviewEmbed(visible)],
          components: [categorySelect(category)],
        };
      }

      if (entries.length === 0) {
        return {
          embeds: [emptyCategoryEmbed(category)],
          components: [categorySelect(category)],
        };
      }

      index = Math.min(Math.max(index, 0), entries.length - 1);
      return {
        embeds: [detailEmbed(client, entries[index], index, entries.length)],
        components: [
          categorySelect(category),
          commandSelect(entries, index),
          navigationButtons(index, entries.length),
        ],
      };
    };

    const message = await interaction.editReply(render());
    const collector = message.createMessageComponentCollector({
      time: 10 * 60 * 1000,
      filter: component => component.user.id === interaction.user.id,
    });

    collector.on('collect', async component => {
      if (component.isStringSelectMenu()) {
        if (component.customId === 'help_category') {
          category = component.values[0] as HelpCategory;
          entries = entriesFor(visible, category);
          index = 0;
        } else if (component.customId === 'help_command') {
          const selectedIndex = entries.findIndex(entry => entry.name === component.values[0]);
          if (selectedIndex >= 0) index = selectedIndex;
        }
      } else if (component.isButton()) {
        if (component.customId === 'help_prev') index = Math.max(0, index - 1);
        if (component.customId === 'help_next') index = Math.min(entries.length - 1, index + 1);
        if (component.customId === 'help_home') {
          category = 'overview';
          entries = visible;
          index = 0;
        }
      }

      await component.update(render());
    });

    collector.on('end', () => {
      void interaction.editReply({ components: [] }).catch(() => undefined);
    });
  },
};

export default helpCommand;
