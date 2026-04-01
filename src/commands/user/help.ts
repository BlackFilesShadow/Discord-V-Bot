import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
} from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { config } from '../../config';

/**
 * /help Command (Sektion 4):
 * Help-Menü mit Pagination (Pfeil-Buttons) — alle Kategorien in einem Fenster switchbar.
 */
const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Zeigt alle verfügbaren Commands an')
    .addStringOption(opt =>
      opt
        .setName('category')
        .setDescription('Direkt zu einer Kategorie springen')
        .setRequired(false)
        .addChoices(
          { name: 'Registrierung', value: 'registration' },
          { name: 'Upload & Download', value: 'upload' },
          { name: 'Pakete', value: 'packages' },
          { name: 'Giveaway', value: 'giveaway' },
          { name: 'Level & XP', value: 'level' },
          { name: 'Umfragen', value: 'polls' },
          { name: 'Moderation', value: 'moderation' },
          { name: 'Admin', value: 'admin' },
        )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const category = interaction.options.getString('category');
    const isAdmin = await checkIsAdmin(interaction.user.id);

    const pages = buildPages(isAdmin);

    let currentPage = 0;
    if (category) {
      const idx = pages.findIndex(p => p.id === category);
      if (idx >= 0) currentPage = idx;
    }

    const row = buildButtons(currentPage, pages.length);
    const response = await interaction.reply({
      embeds: [pages[currentPage].embed],
      components: [row],
      ephemeral: true,
    });

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 300_000,
    });

    collector.on('collect', async (btn) => {
      if (btn.user.id !== interaction.user.id) {
        await btn.reply({ content: 'Das ist nicht dein Help-Menü.', ephemeral: true });
        return;
      }

      if (btn.customId === 'help_prev') {
        currentPage = Math.max(0, currentPage - 1);
      } else if (btn.customId === 'help_next') {
        currentPage = Math.min(pages.length - 1, currentPage + 1);
      } else if (btn.customId === 'help_first') {
        currentPage = 0;
      } else if (btn.customId === 'help_last') {
        currentPage = pages.length - 1;
      }

      await btn.update({
        embeds: [pages[currentPage].embed],
        components: [buildButtons(currentPage, pages.length)],
      });
    });

    collector.on('end', async () => {
      try {
        await interaction.editReply({ components: [] });
      } catch {
        // Message may be deleted
      }
    });
  },
};

async function checkIsAdmin(userId: string): Promise<boolean> {
  if (userId === config.discord.ownerId) return true;
  const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
  return !!dbUser && ['ADMIN', 'DEVELOPER', 'SUPER_ADMIN'].includes(dbUser.role);
}

function buildButtons(current: number, total: number): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('help_first')
      .setEmoji('⏮')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(current === 0),
    new ButtonBuilder()
      .setCustomId('help_prev')
      .setEmoji('◀')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(current === 0),
    new ButtonBuilder()
      .setCustomId('help_page_indicator')
      .setLabel(`${current + 1} / ${total}`)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId('help_next')
      .setEmoji('▶')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(current >= total - 1),
    new ButtonBuilder()
      .setCustomId('help_last')
      .setEmoji('⏭')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(current >= total - 1),
  );
}

interface HelpPage { id: string; embed: EmbedBuilder; }

function buildPages(isAdmin: boolean): HelpPage[] {
  const pages: HelpPage[] = [
    {
      id: 'overview',
      embed: new EmbedBuilder()
        .setTitle('📖 Discord-V-Bot – Hilfe')
        .setDescription('Verwende ◀ ▶ um durch die Kategorien zu navigieren.')
        .setColor(0x0099ff)
        .addFields(
          { name: '📝 Registrierung', value: 'Hersteller werden & verifizieren', inline: true },
          { name: '📤 Upload & Download', value: 'Dateien hoch-/herunterladen', inline: true },
          { name: '📦 Pakete', value: 'Eigene Pakete verwalten', inline: true },
          { name: '🎉 Giveaway', value: 'Giveaways erstellen & teilnehmen', inline: true },
          { name: '⭐ Level & XP', value: 'Level, XP & Leaderboard', inline: true },
          { name: '📊 Umfragen', value: 'Umfragen erstellen & abstimmen', inline: true },
          { name: '🛡️ Moderation', value: 'Kick, Ban, Mute, Warn', inline: true },
          { name: '🔗 Feeds', value: 'News & Social Media Feeds', inline: true },
          { name: '🛠️ Auto-Rollen', value: 'Automatische Rollenvergabe', inline: true },
        )
        .setFooter({ text: 'Seite 1 – Übersicht' })
        .setTimestamp(),
    },
    {
      id: 'registration',
      embed: new EmbedBuilder()
        .setTitle('📝 Registrierung')
        .setDescription('Registriere dich als Hersteller, um Pakete hochzuladen.')
        .setColor(0x0099ff)
        .addFields(
          { name: '/register manufacturer [reason]', value: 'Sende eine Hersteller-Anfrage an den Admin.' },
          { name: '/register verify <password>', value: 'Gib dein Einmal-Passwort ein.' },
        )
        .setFooter({ text: 'Seite 2 – Registrierung' }),
    },
    {
      id: 'upload',
      embed: new EmbedBuilder()
        .setTitle('📤 Upload & Download')
        .setDescription('Lade Dateien hoch oder herunter.')
        .setColor(0x0099ff)
        .addFields(
          { name: '/upload', value: 'Lade eine Datei hoch (XML, JSON, bis 2 GB). Dropdown-Menü für Format-Auswahl.' },
          { name: '/download <paketname>', value: 'Lade ein Paket oder Datei herunter. Dropdown für Hersteller & Format.' },
          { name: '/search <suchbegriff>', value: 'Suche nach Paketen, Dateien oder Nutzern.' },
        )
        .setFooter({ text: 'Seite 3 – Upload & Download' }),
    },
    {
      id: 'packages',
      embed: new EmbedBuilder()
        .setTitle('📦 Pakete')
        .setDescription('Verwalte deine eigenen Pakete.')
        .setColor(0x0099ff)
        .addFields(
          { name: '/mypackages list', value: 'Zeige alle deine Pakete.' },
          { name: '/mypackages info <paket>', value: 'Detailansicht eines Pakets.' },
          { name: '/mypackages delete <paket>', value: 'Paket löschen (Soft-Delete).' },
          { name: '/mypackages restore <paket>', value: 'Gelöschtes Paket wiederherstellen.' },
        )
        .setFooter({ text: 'Seite 4 – Pakete' }),
    },
    {
      id: 'giveaway',
      embed: new EmbedBuilder()
        .setTitle('🎉 Giveaway')
        .setDescription('Erstelle und verwalte Giveaways.')
        .setColor(0x0099ff)
        .addFields(
          { name: '/giveaway start <preis> <dauer>', value: 'Starte ein neues Giveaway.' },
          { name: '/giveaway enter <id>', value: 'Nimm an einem Giveaway teil.' },
          { name: '/giveaway info <id>', value: 'Zeige Infos zu einem Giveaway.' },
          { name: '/giveaway end <id>', value: 'Beende ein Giveaway vorzeitig.' },
        )
        .setFooter({ text: 'Seite 5 – Giveaway' }),
    },
    {
      id: 'level',
      embed: new EmbedBuilder()
        .setTitle('⭐ Level & XP')
        .setDescription('Sammle XP durch Aktivität.')
        .setColor(0x0099ff)
        .addFields(
          { name: '/level [user]', value: 'Zeige dein Level oder das eines anderen Users.' },
          { name: '/leaderboard [seite]', value: 'Zeige die Top-User nach Level/XP.' },
        )
        .setFooter({ text: 'Seite 6 – Level & XP' }),
    },
    {
      id: 'polls',
      embed: new EmbedBuilder()
        .setTitle('📊 Umfragen')
        .setDescription('Erstelle Umfragen und Abstimmungen.')
        .setColor(0x0099ff)
        .addFields(
          { name: '/poll create <titel> <optionen>', value: 'Erstelle eine neue Umfrage.' },
          { name: '/poll vote <id> <option>', value: 'Stimme in einer Umfrage ab.' },
          { name: '/poll results <id>', value: 'Zeige die Ergebnisse.' },
          { name: '/poll end <id>', value: 'Beende eine Umfrage vorzeitig.' },
        )
        .setFooter({ text: 'Seite 7 – Umfragen' }),
    },
    {
      id: 'moderation',
      embed: new EmbedBuilder()
        .setTitle('🛡️ Moderation')
        .setDescription('Moderationstools für Admins und Moderatoren.')
        .setColor(0x0099ff)
        .addFields(
          { name: '/kick <user> <grund>', value: 'Nutzer kicken.' },
          { name: '/ban <user> <grund> [dauer]', value: 'Nutzer bannen.' },
          { name: '/mute <user> <grund> [dauer]', value: 'Nutzer muten.' },
          { name: '/warn <user> <grund>', value: 'Nutzer verwarnen.' },
          { name: '/appeal <case-id> <begründung>', value: 'Beschwerde einreichen.' },
        )
        .setFooter({ text: 'Seite 8 – Moderation' }),
    },
  ];

  if (isAdmin) {
    pages.push({
      id: 'admin',
      embed: new EmbedBuilder()
        .setTitle('⚙️ Admin-Commands')
        .setDescription('Alle Admin/Developer-Commands.')
        .setColor(0xff9900)
        .addFields(
          { name: '/admin-approve <user>', value: 'Hersteller annehmen', inline: true },
          { name: '/admin-deny <user>', value: 'Hersteller ablehnen', inline: true },
          { name: '/admin-list-users', value: 'Alle Nutzer anzeigen', inline: true },
          { name: '/admin-list-pakete', value: 'Alle Pakete anzeigen', inline: true },
          { name: '/admin-logs', value: 'Live-Log-Stream', inline: true },
          { name: '/admin-delete', value: 'Löschen (Soft/Hard)', inline: true },
          { name: '/admin-broadcast', value: 'Broadcast an alle', inline: true },
          { name: '/admin-stats', value: 'Systemstatistiken', inline: true },
          { name: '/admin-validate', value: 'Manuelle Validierung', inline: true },
          { name: '/admin-reset-password', value: 'Passwort zurücksetzen', inline: true },
          { name: '/admin-toggle-upload', value: 'Uploadrechte togglen', inline: true },
          { name: '/admin-export', value: 'Daten exportieren', inline: true },
          { name: '/admin-error-report', value: 'Fehlerberichte', inline: true },
          { name: '/admin-config', value: 'Bot-Konfiguration', inline: true },
          { name: '/admin-audit', value: 'Audit-Log', inline: true },
          { name: '/admin-appeals', value: 'Beschwerden verwalten', inline: true },
          { name: '/admin-security', value: 'Sicherheitsübersicht', inline: true },
          { name: '/admin-monitor', value: 'System-Monitoring', inline: true },
          { name: '/feed', value: 'Feed-Management', inline: true },
        )
        .setFooter({ text: `Seite ${pages.length + 1} – Admin` }),
    });
  }

  return pages;
}

export default helpCommand;
