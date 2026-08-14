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
import prisma from '../../database/prisma';
import { visibleCommandCatalog, type CommandCatalogEntry } from '../catalog';
import { Colors, Brand } from '../../utils/embedDesign';

const PAGE_SIZE = 18;
type HelpFilter = 'all' | 'public' | 'manufacturer' | 'dashboard';

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

async function resolveAccess(discordId: string): Promise<{ isAdmin: boolean; isDeveloper: boolean; isManufacturer: boolean }> {
  const user = await prisma.user.findUnique({
    where: { discordId },
    select: { isManufacturer: true, status: true },
  });
  return {
    // /help is intentionally never a discovery surface for Bot-Admin/DEV
    // commands. Those capabilities belong in their dedicated dashboard areas.
    isAdmin: false,
    isDeveloper: false,
    isManufacturer: Boolean(user?.isManufacturer && user.status === 'ACTIVE'),
  };
}

function filterEntries(entries: CommandCatalogEntry[], filter: HelpFilter): CommandCatalogEntry[] {
  if (filter === 'all') return entries;
  if (filter === 'dashboard') return entries.filter((entry) => entry.dashboardReplacement);
  return entries.filter((entry) => entry.audience === filter);
}

function pageEmbed(entries: CommandCatalogEntry[], page: number, totalPages: number, filter: HelpFilter): EmbedBuilder {
  const start = page * PAGE_SIZE;
  const chunk = entries.slice(start, start + PAGE_SIZE);
  const body = chunk.length
    ? chunk.map((entry) => {
      const badges = [
        entry.audience === 'manufacturer' ? '🏭' : '',
        entry.dashboardReplacement ? '🖥️' : '',
      ].filter(Boolean).join('');
      return `${badges ? `${badges} ` : ''}\`/${entry.name}\` — ${truncate(entry.description || 'Keine Beschreibung.', 105)}`;
    }).join('\n')
    : '_Keine Commands in dieser Ansicht._';

  return new EmbedBuilder()
    .setColor(Colors.Primary)
    .setTitle('📚 Command-Katalog')
    .setDescription(
      `Filter: **${filter}** · ${entries.length} Commands · Seite ${page + 1}/${totalPages}\n` +
      '🏭 Hersteller · 🖥️ auch im Dashboard\n\n' +
      `${Brand.divider}\n${body}`,
    )
    .setFooter({ text: 'Bot-Admin- und DEV-Funktionen werden nicht in /help angezeigt.' })
    .setTimestamp();
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
    .setDescription('Zeigt den aktuellen Command-Katalog an.')
    .addStringOption((option) => option
      .setName('category')
      .setDescription('Command-Gruppe filtern')
      .setRequired(false)
      .addChoices(
        { name: 'Alle sichtbaren Commands', value: 'all' },
        { name: 'Öffentlich', value: 'public' },
        { name: 'Hersteller', value: 'manufacturer' },
        { name: 'Auch im Dashboard', value: 'dashboard' },
      )),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const access = await resolveAccess(interaction.user.id);
    const client = interaction.client as ExtendedClient;
    const visible = visibleCommandCatalog(client, access);
    const requested = (interaction.options.getString('category') ?? 'all') as HelpFilter;
    const entries = filterEntries(visible, requested);
    const totalPages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    let page = 0;

    const message = await interaction.editReply({
      embeds: [pageEmbed(entries, page, totalPages, requested)],
      components: totalPages > 1 ? [buttons(page, totalPages)] : [],
    });

    if (totalPages <= 1) return;
    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000,
      filter: (component) => component.user.id === interaction.user.id,
    });
    collector.on('collect', async (component) => {
      if (component.customId === 'help_prev') page = Math.max(0, page - 1);
      if (component.customId === 'help_next') page = Math.min(totalPages - 1, page + 1);
      await component.update({ embeds: [pageEmbed(entries, page, totalPages, requested)], components: [buttons(page, totalPages)] });
    });
    collector.on('end', () => { void interaction.editReply({ components: [] }).catch(() => undefined); });
  },
};

export default helpCommand;
