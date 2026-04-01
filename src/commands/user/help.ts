import { SlashCommandBuilder, ChatInputCommandInteraction, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { Command } from '../../types';
import prisma from '../../database/prisma';

/**
 * /help Command (Sektion 4):
 * Help-Menü mit Übersicht aller Commands.
 */
const helpCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Zeigt alle verfügbaren Commands an')
    .addStringOption(opt =>
      opt
        .setName('category')
        .setDescription('Kategorie anzeigen')
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

    if (category) {
      await showCategoryHelp(interaction, category);
    } else {
      await showMainHelp(interaction);
    }
  },
};

async function showMainHelp(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('📖 Discord-V-Bot – Hilfe')
    .setDescription('Übersicht aller verfügbaren Commands. Verwende `/help <kategorie>` für Details.')
    .setColor(0x0099ff)
    .addFields(
      {
        name: '📝 Registrierung',
        value: '`/register manufacturer` – Als Hersteller registrieren\n`/register verify` – Einmal-Passwort eingeben',
        inline: false,
      },
      {
        name: '📤 Upload & Download',
        value: '`/upload` – Dateien/Pakete hochladen\n`/download` – Dateien/Pakete herunterladen\n`/search` – Pakete suchen',
        inline: false,
      },
      {
        name: '📦 Pakete',
        value: '`/mypackages` – Eigene Pakete anzeigen\n`/mypackages delete` – Paket löschen\n`/mypackages restore` – Paket wiederherstellen',
        inline: false,
      },
      {
        name: '🎉 Giveaway',
        value: '`/giveaway start` – Giveaway starten\n`/giveaway enter` – Teilnehmen\n`/giveaway info` – Info anzeigen',
        inline: false,
      },
      {
        name: '⭐ Level & XP',
        value: '`/level` – Dein Level anzeigen\n`/leaderboard` – Top-User anzeigen',
        inline: false,
      },
      {
        name: '📊 Umfragen',
        value: '`/poll create` – Umfrage erstellen\n`/poll vote` – Abstimmen\n`/poll results` – Ergebnisse anzeigen',
        inline: false,
      },
      {
        name: '🛡️ Moderation',
        value: '`/kick` `/ban` `/mute` `/warn` – Moderationsaktionen\n`/appeal` – Beschwerde einreichen',
        inline: false,
      },
      {
        name: '⚙️ Admin',
        value: 'Verwende `/help admin` für die vollständige Admin-Übersicht.',
        inline: false,
      },
    )
    .setFooter({ text: 'Discord-V-Bot v1.0' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function showCategoryHelp(interaction: ChatInputCommandInteraction, category: string) {
  const embed = new EmbedBuilder().setColor(0x0099ff).setTimestamp();

  switch (category) {
    case 'registration':
      embed
        .setTitle('📝 Registrierung – Hilfe')
        .setDescription('Registriere dich als Hersteller, um Pakete hochzuladen.')
        .addFields(
          { name: '/register manufacturer [reason]', value: 'Sende eine Hersteller-Anfrage an den Admin. Optional mit Begründung.', inline: false },
          { name: '/register verify <password>', value: 'Gib dein Einmal-Passwort ein, um deinen GUID-Bereich zu aktivieren.', inline: false },
        );
      break;

    case 'upload':
      embed
        .setTitle('📤 Upload & Download – Hilfe')
        .setDescription('Lade Dateien hoch oder herunter.')
        .addFields(
          { name: '/upload <paketname> <datei>', value: 'Lade eine Datei in ein bestehendes oder neues Paket hoch (XML, JSON, bis 2 GB).', inline: false },
          { name: '/download <paketname> [datei]', value: 'Lade ein ganzes Paket oder eine einzelne Datei herunter (ZIP/TAR/Einzeldatei).', inline: false },
          { name: '/search <suchbegriff>', value: 'Suche nach Paketen, Dateien oder Nutzern.', inline: false },
        );
      break;

    case 'packages':
      embed
        .setTitle('📦 Pakete – Hilfe')
        .setDescription('Verwalte deine eigenen Pakete.')
        .addFields(
          { name: '/mypackages list', value: 'Zeige alle deine Pakete mit Metadaten.', inline: false },
          { name: '/mypackages info <paket>', value: 'Detailansicht eines Pakets.', inline: false },
          { name: '/mypackages delete <paket>', value: 'Paket löschen (Soft-Delete, Restore möglich).', inline: false },
          { name: '/mypackages restore <paket>', value: 'Gelöschtes Paket wiederherstellen.', inline: false },
        );
      break;

    case 'giveaway':
      embed
        .setTitle('🎉 Giveaway – Hilfe')
        .setDescription('Erstelle und verwalte Giveaways.')
        .addFields(
          { name: '/giveaway start <preis> <dauer> [beschreibung]', value: 'Starte ein neues Giveaway. Dauer z.B.: 1h, 30m, 2d.', inline: false },
          { name: '/giveaway enter <id>', value: 'Nimm an einem Giveaway teil.', inline: false },
          { name: '/giveaway info <id>', value: 'Zeige Infos zu einem Giveaway.', inline: false },
          { name: '/giveaway end <id>', value: 'Beende ein Giveaway vorzeitig (nur Ersteller/Admin).', inline: false },
        );
      break;

    case 'level':
      embed
        .setTitle('⭐ Level & XP – Hilfe')
        .setDescription('Sammle XP durch Aktivität und steige im Level auf.')
        .addFields(
          { name: '/level [user]', value: 'Zeige dein Level und XP oder das eines anderen Users.', inline: false },
          { name: '/leaderboard [seite]', value: 'Zeige die Top-User nach Level/XP.', inline: false },
        );
      break;

    case 'polls':
      embed
        .setTitle('📊 Umfragen – Hilfe')
        .setDescription('Erstelle Umfragen und Abstimmungen.')
        .addFields(
          { name: '/poll create <titel> <optionen>', value: 'Erstelle eine neue Umfrage. Optionen mit Komma trennen.', inline: false },
          { name: '/poll vote <id> <option>', value: 'Stimme in einer Umfrage ab.', inline: false },
          { name: '/poll results <id>', value: 'Zeige die Ergebnisse einer Umfrage.', inline: false },
          { name: '/poll end <id>', value: 'Beende eine Umfrage vorzeitig.', inline: false },
        );
      break;

    case 'moderation':
      embed
        .setTitle('🛡️ Moderation – Hilfe')
        .setDescription('Moderationstools für Admins und Moderatoren.')
        .addFields(
          { name: '/kick <user> <grund>', value: 'Nutzer kicken.', inline: false },
          { name: '/ban <user> <grund> [dauer]', value: 'Nutzer bannen (permanent oder temporär).', inline: false },
          { name: '/mute <user> <grund> [dauer]', value: 'Nutzer muten.', inline: false },
          { name: '/warn <user> <grund>', value: 'Nutzer verwarnen.', inline: false },
          { name: '/appeal <case-id> <begründung>', value: 'Beschwerde gegen Moderation einreichen.', inline: false },
        );
      break;

    case 'admin': {
      // Dev-Auth: Nur Admins/Developer sehen erweiterte Admin-Hilfe (Sektion 4)
      const dbUser = await prisma.user.findUnique({ where: { discordId: interaction.user.id } });
      const isAdmin = dbUser && ['ADMIN', 'DEVELOPER', 'SUPER_ADMIN'].includes(dbUser.role);

      if (!isAdmin) {
        embed
          .setTitle('⚙️ Admin-Commands')
          .setDescription('❌ Du benötigst Admin- oder Developer-Rechte, um die Admin-Hilfe zu sehen.');
        break;
      }

      embed
        .setTitle('⚙️ Admin-Commands – Hilfe')
        .setDescription('Alle Admin/Developer-Commands.')
        .addFields(
          { name: '/admin-approve <user>', value: 'Hersteller-Anfrage annehmen', inline: true },
          { name: '/admin-deny <user>', value: 'Hersteller-Anfrage ablehnen', inline: true },
          { name: '/admin-list-users', value: 'Alle Nutzer/Hersteller anzeigen', inline: true },
          { name: '/admin-list-pakete', value: 'Alle Pakete anzeigen', inline: true },
          { name: '/admin-logs <filter>', value: 'Live-Log-Stream', inline: true },
          { name: '/admin-delete <target>', value: 'Löschen (Soft/Hard)', inline: true },
          { name: '/admin-broadcast <msg>', value: 'Broadcast an alle', inline: true },
          { name: '/admin-stats', value: 'Systemstatistiken', inline: true },
          { name: '/admin-validate <target>', value: 'Manuelle Validierung', inline: true },
          { name: '/admin-reset-password <user>', value: 'Passwort zurücksetzen', inline: true },
          { name: '/admin-toggle-upload <user>', value: 'Uploadrechte togglen', inline: true },
          { name: '/admin-export <bereich>', value: 'Daten exportieren', inline: true },
          { name: '/admin-error-report', value: 'Fehlerberichte', inline: true },
          { name: '/admin-config', value: 'Konfiguration', inline: true },
          { name: '/admin-audit <filter>', value: 'Audit-Log', inline: true },
          { name: '/admin-appeals', value: 'Appeals verwalten', inline: true },
          { name: '/admin-security', value: 'Security-Events', inline: true },
          { name: '/admin-monitor', value: 'Live-Monitoring', inline: true },
        );
      break;
    }
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

export default helpCommand;
