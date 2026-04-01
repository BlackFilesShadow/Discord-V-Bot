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
 * /help Command:
 * Info-Tafel mit Pagination — alle Commands mit Kurzerklärung.
 * Admin-Seiten nur für Admins sichtbar.
 * DEV-Seiten nur für authentifizierte Developer sichtbar.
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
          { name: 'Übersicht', value: 'overview' },
          { name: 'Registrierung', value: 'registration' },
          { name: 'Upload & Download', value: 'upload' },
          { name: 'Pakete', value: 'packages' },
          { name: 'Giveaway', value: 'giveaway' },
          { name: 'Level & XP', value: 'level' },
          { name: 'Umfragen', value: 'polls' },
          { name: 'Moderation', value: 'moderation' },
        )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    const category = interaction.options.getString('category');
    const { isAdmin, isDev } = await checkUserRoles(interaction.user.id);

    const pages = buildPages(isAdmin, isDev);

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

async function checkUserRoles(userId: string): Promise<{ isAdmin: boolean; isDev: boolean }> {
  const isOwner = userId === config.discord.ownerId;
  if (isOwner) return { isAdmin: true, isDev: true };

  const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
  if (!dbUser) return { isAdmin: false, isDev: false };

  const isAdmin = ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(dbUser.role);
  const isDev = dbUser.role === 'DEVELOPER';
  return { isAdmin, isDev };
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

function buildPages(isAdmin: boolean, isDev: boolean): HelpPage[] {
  const pages: HelpPage[] = [
    // ── Seite 1: Übersicht ──
    {
      id: 'overview',
      embed: new EmbedBuilder()
        .setTitle('📖 V-Bot – Command-Übersicht')
        .setDescription(
          'Verwende ◀ ▶ um durch die Kategorien zu blättern.\n' +
          'Jede Seite zeigt die verfügbaren Commands mit Kurzerklärung.\n\n' +
          '**Kategorien:**'
        )
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
    // ── Seite 2: Registrierung ──
    {
      id: 'registration',
      embed: new EmbedBuilder()
        .setTitle('📝 Registrierung')
        .setDescription('Werde Hersteller, um Pakete hochzuladen.')
        .setColor(0x0099ff)
        .addFields(
          { name: '`/register manufacturer [reason]`', value: 'Sende eine Hersteller-Anfrage an den Admin.' },
          { name: '`/register verify <password>`', value: 'Gib dein Einmal-Passwort (OTP) ein, um dich zu verifizieren.' },
        )
        .setFooter({ text: 'Seite 2 – Registrierung' }),
    },
    // ── Seite 3: Upload & Download ──
    {
      id: 'upload',
      embed: new EmbedBuilder()
        .setTitle('📤 Upload & Download')
        .setDescription('Lade XML/JSON-Dateien hoch oder lade Pakete herunter.')
        .setColor(0x0099ff)
        .addFields(
          { name: '`/upload <paketname> <datei> [datei2..datei10] [beschreibung]`', value: 'Lade bis zu **10 Dateien** (XML/JSON) gleichzeitig in ein Paket hoch.' },
          { name: '`/download`', value: 'Wähle zuerst einen Hersteller, dann eine einzelne Datei zum Download.' },
          { name: '`/search <suchbegriff>`', value: 'Suche nach Paketen, Dateien oder Herstellern.' },
        )
        .setFooter({ text: 'Seite 3 – Upload & Download' }),
    },
    // ── Seite 4: Pakete ──
    {
      id: 'packages',
      embed: new EmbedBuilder()
        .setTitle('📦 Meine Pakete')
        .setDescription('Verwalte deine eigenen Pakete als Hersteller.')
        .setColor(0x0099ff)
        .addFields(
          { name: '`/mypackages list`', value: 'Zeige alle deine Pakete an.' },
          { name: '`/mypackages info <paket>`', value: 'Detailansicht eines Pakets (Dateien, Größe, Status).' },
          { name: '`/mypackages delete <paket>`', value: 'Paket löschen (Soft-Delete, wiederherstellbar).' },
          { name: '`/mypackages restore <paket>`', value: 'Gelöschtes Paket wiederherstellen.' },
          { name: '`/mypackages delete-file`', value: 'Einzelne Datei aus einem Paket löschen (Dropdown).' },
        )
        .setFooter({ text: 'Seite 4 – Pakete' }),
    },
    // ── Seite 5: Giveaway ──
    {
      id: 'giveaway',
      embed: new EmbedBuilder()
        .setTitle('🎉 Giveaway')
        .setDescription('Erstelle und verwalte Giveaways.')
        .setColor(0x0099ff)
        .addFields(
          { name: '`/giveaway start <preis> <dauer>`', value: 'Starte ein neues Giveaway mit Preis und Dauer.' },
          { name: '`/giveaway enter <id>`', value: 'Nimm an einem laufenden Giveaway teil.' },
          { name: '`/giveaway info <id>`', value: 'Zeige Infos zu einem Giveaway an.' },
          { name: '`/giveaway end <id>`', value: 'Beende ein Giveaway vorzeitig (nur Ersteller).' },
        )
        .setFooter({ text: 'Seite 5 – Giveaway' }),
    },
    // ── Seite 6: Level & XP ──
    {
      id: 'level',
      embed: new EmbedBuilder()
        .setTitle('⭐ Level & XP')
        .setDescription('Sammle XP durch Aktivität im Server.')
        .setColor(0x0099ff)
        .addFields(
          { name: '`/level [user]`', value: 'Zeige dein Level oder das eines anderen Users.' },
          { name: '`/leaderboard [seite]`', value: 'Zeige das Leaderboard (Top-User nach XP).' },
        )
        .setFooter({ text: 'Seite 6 – Level & XP' }),
    },
    // ── Seite 7: Umfragen ──
    {
      id: 'polls',
      embed: new EmbedBuilder()
        .setTitle('📊 Umfragen')
        .setDescription('Erstelle Umfragen und stimme ab.')
        .setColor(0x0099ff)
        .addFields(
          { name: '`/poll erstellen <titel> <optionen> [dauer] [einheit]`', value: 'Erstelle eine Umfrage. Dauer in Min/Std/Tage/Wochen.' },
          { name: '`/poll vote <id> <option>`', value: 'Stimme in einer Umfrage ab.' },
          { name: '`/poll results <id>`', value: 'Zeige die aktuellen Ergebnisse.' },
          { name: '`/poll end <id>`', value: 'Beende eine laufende Umfrage vorzeitig.' },
        )
        .setFooter({ text: 'Seite 7 – Umfragen' }),
    },
    // ── Seite 8: Moderation ──
    {
      id: 'moderation',
      embed: new EmbedBuilder()
        .setTitle('🛡️ Moderation')
        .setDescription('Moderationstools (benötigt entsprechende Rechte).')
        .setColor(0x0099ff)
        .addFields(
          { name: '`/kick <user> <grund>`', value: 'Nutzer aus dem Server kicken.' },
          { name: '`/ban <user> <grund> [dauer]`', value: 'Nutzer bannen (optional: temporär).' },
          { name: '`/mute <user> <grund> [dauer]`', value: 'Nutzer stummschalten.' },
          { name: '`/warn <user> <grund>`', value: 'Nutzer verwarnen (Verwarnungspunkte).' },
          { name: '`/appeal <case-id> <begründung>`', value: 'Beschwerde gegen eine Moderation einreichen.' },
        )
        .setFooter({ text: 'Seite 8 – Moderation' }),
    },
  ];

  // ── Admin-Seiten (nur für Admins) ──
  if (isAdmin) {
    pages.push({
      id: 'admin1',
      embed: new EmbedBuilder()
        .setTitle('⚙️ Admin-Commands (1/2)')
        .setDescription('Nur für Admins sichtbar. Erfordert Admin-Rolle in der Datenbank.')
        .setColor(0xff9900)
        .addFields(
          { name: '`/admin-approve <user|user_id>`', value: 'Hersteller-Anfrage annehmen.' },
          { name: '`/admin-deny <user|user_id>`', value: 'Hersteller-Anfrage ablehnen.' },
          { name: '`/admin-list-users`', value: 'Alle registrierten Nutzer anzeigen.' },
          { name: '`/admin-list-pakete`', value: 'Alle Pakete im System anzeigen.' },
          { name: '`/admin-logs`', value: 'Live-Log-Stream ansehen.' },
          { name: '`/admin-delete <typ> <id>`', value: 'Soft- oder Hard-Delete von Einträgen.' },
          { name: '`/admin-broadcast <nachricht>`', value: 'Broadcast-Nachricht an alle Nutzer.' },
          { name: '`/admin-stats`', value: 'Systemstatistiken anzeigen.' },
          { name: '`/admin-validate <datei-id>`', value: 'Manuelle Datei-Validierung.' },
        )
        .setFooter({ text: `Seite ${pages.length + 1} – Admin (1/2)` }),
    });
    pages.push({
      id: 'admin2',
      embed: new EmbedBuilder()
        .setTitle('⚙️ Admin-Commands (2/2)')
        .setDescription('Weitere Admin-Commands.')
        .setColor(0xff9900)
        .addFields(
          { name: '`/admin-reset-password <user>`', value: 'Passwort eines Nutzers zurücksetzen.' },
          { name: '`/admin-toggle-upload <user>`', value: 'Uploadrechte eines Nutzers an/aus.' },
          { name: '`/admin-export <typ>`', value: 'Daten als CSV/JSON exportieren.' },
          { name: '`/admin-error-report`', value: 'Fehlerberichte anzeigen.' },
          { name: '`/admin-config <key> <value>`', value: 'Bot-Konfiguration ändern.' },
          { name: '`/admin-audit`', value: 'Audit-Log einsehen.' },
          { name: '`/admin-appeals`', value: 'Beschwerden verwalten.' },
          { name: '`/admin-security`', value: 'Sicherheitsübersicht anzeigen.' },
          { name: '`/admin-monitor`', value: 'System-Monitoring (CPU, RAM, DB).' },
          { name: '`/feed <aktion>`', value: 'Feed-Management (hinzufügen/entfernen).' },
        )
        .setFooter({ text: `Seite ${pages.length + 2} – Admin (2/2)` }),
    });
  }

  // ── DEV-Seiten (nur für Developer) ──
  if (isDev) {
    pages.push({
      id: 'developer',
      embed: new EmbedBuilder()
        .setTitle('🔐 Developer-Commands')
        .setDescription(
          'Nur im DEV-Bereich sichtbar. Erfordert `/dev-login` mit Passwort.\n' +
          'DEV-Session ist **2 Stunden** gültig.'
        )
        .setColor(0xff0000)
        .addFields(
          { name: '`/dev-login`', value: 'Developer-Bereich freischalten (Passwort-Modal).' },
          { name: '`/dev-eval <check>`', value: 'Systemdiagnostik (System/DB/Memory/Uptime).' },
          { name: '`/dev-db <aktion>`', value: 'Datenbankmanagement (Tabellen/User-Suche/Cleanup).' },
          { name: '`/dev-reload`', value: 'Commands hot-reloaden ohne Bot-Neustart.' },
          { name: '`/dev-admin <aktion>`', value: 'Admin-Rollen verwalten (add/remove/list).' },
          { name: '`/dev-manufacturer <aktion>`', value: 'Hersteller verwalten (remove/list).' },
        )
        .setFooter({ text: `Seite ${pages.length + 1} – Developer` }),
    });
  }

  return pages;
}

export default helpCommand;
