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
import { Colors, Brand, vEmbed } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';

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
              { name: 'Support', value: 'support' },
              { name: 'Giveaway', value: 'giveaway' },
              { name: 'Level & XP', value: 'level' },
              { name: 'Umfragen', value: 'polls' },
              { name: 'Moderation', value: 'moderation' },
              { name: 'Utility & Tools', value: 'utility' },
              { name: 'KI & Auto', value: 'ai' }
            )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const { isAdmin, isDev } = await checkUserRoles(interaction.user.id);
    const pages = buildPages(isAdmin, isDev);

    // Optional: direkt zu einer Kategorie springen
    const requested = interaction.options.getString('category');
    let current = 0;
    if (requested) {
      const idx = pages.findIndex(p => p.id === requested);
      if (idx >= 0) current = idx;
    }

    const message = await interaction.editReply({
      embeds: [pages[current].embed],
      components: pages.length > 1 ? [buildButtons(current, pages.length)] : [],
    });

    if (pages.length <= 1) return;

    const collector = message.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 5 * 60 * 1000, // 5 Minuten
      filter: i => i.user.id === interaction.user.id,
    });

    collector.on('collect', async btn => {
      if (btn.customId === 'help_first') current = 0;
      else if (btn.customId === 'help_prev') current = Math.max(0, current - 1);
      else if (btn.customId === 'help_next') current = Math.min(pages.length - 1, current + 1);
      else if (btn.customId === 'help_last') current = pages.length - 1;
      else return;

      try {
        await btn.update({
          embeds: [pages[current].embed],
          components: [buildButtons(current, pages.length)],
        });
      } catch { /* ignore */ }
    });

    collector.on('end', async () => {
      try { await interaction.editReply({ components: [] }); } catch { /* ignore */ }
    });
  },
};

async function checkUserRoles(userId: string): Promise<{ isAdmin: boolean; isDev: boolean }> {
  const isOwner = userId === config.discord.ownerId;
  if (isOwner) return { isAdmin: true, isDev: true };

  // DEV-Session prüfen
  const { devAuthenticatedUsers } = require('../../events/interactionCreate');
  const sessionValid = devAuthenticatedUsers?.get(userId) > Date.now();

  const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
  if (!dbUser) return { isAdmin: false, isDev: false };

  const isAdmin = ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(dbUser.role);
  const isDev = dbUser.role === 'DEVELOPER' && sessionValid;
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
      embed: createBotEmbed({
        title: '📖  V-Bot — Command-Übersicht',
        description: '> Willkommen beim **V-Bot**! Blättere mit ◀ ▶ durch die Kategorien.\n\n' + Brand.divider,
        color: Colors.Primary,
        fields: [
          { name: '📝 Registrierung', value: '`Seite 2`', inline: true },
          { name: '📤 Upload & Download', value: '`Seite 3`', inline: true },
          { name: '📦 Pakete', value: '`Seite 4`', inline: true },
          { name: '🎟️ Support', value: '`Seite 5`', inline: true },
          { name: '🎉 Giveaway', value: '`Seite 6`', inline: true },
          { name: '⭐ Level & XP', value: '`Seite 7`', inline: true },
          { name: '📊 Umfragen', value: '`Seite 8`', inline: true },
          { name: '🛡️ Moderation', value: '`Seite 9`', inline: true },
          { name: '🧰 Utility & Tools', value: '`Seite 10`', inline: true },
          { name: '🤖 KI & Auto', value: '`Seite 11`', inline: true },
          { name: '🔗 Feeds', value: '`/feed`', inline: true },
          { name: '🛠️ Auto-Rollen', value: '`/autorole`', inline: true },
        ],
        footer: `Seite 1 ${Brand.dot} Übersicht ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 2: Registrierung ──
    {
      id: 'registration',
      embed: createBotEmbed({
        title: '📝  Registrierung',
        description: '> Werde Hersteller, um Pakete hochzuladen.\n\n' + Brand.divider,
        color: Colors.Primary,
        fields: [
          { name: '`/register manufacturer`', value: '┃ Sende eine Hersteller-Anfrage an den Admin.' },
          { name: '`/register verify <password>`', value: '┃ Gib dein Einmal-Passwort (OTP) ein.' },
        ],
        footer: `Seite 2 ${Brand.dot} Registrierung ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 3: Upload & Download ──
    {
      id: 'upload',
      embed: createBotEmbed({
        title: '📤  Upload & Download',
        description: '> Lade XML/JSON-Dateien hoch oder lade Pakete herunter.\n\n' + Brand.divider,
        color: Colors.Primary,
        fields: [
          { name: '`/upload <paketname> <datei> [...]`', value: '┃ Bis zu **10 Dateien** gleichzeitig hochladen.' },
          { name: '`/download`', value: '┃ Hersteller → Datei auswählen und herunterladen.' },
          { name: '`/search <suchbegriff>`', value: '┃ Pakete, Dateien oder Hersteller suchen.' },
        ],
        footer: `Seite 3 ${Brand.dot} Upload & Download ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 4: Pakete ──
        // ── Seite 5: Support ──
        {
          id: 'support',
          embed: createBotEmbed({
            title: '🎟️  Support & Tickets',
            description: '> Kontaktiere den Owner direkt per Ticket-System. Alle Anfragen werden archiviert und sind für dich einsehbar.\n\n' + Brand.divider,
            color: Colors.Info,
            fields: [
              { name: '`/ticket open <betreff> <nachricht>`', value: '┃ Erstelle ein neues Support-Ticket. Der Owner wird per DM benachrichtigt.' },
              { name: '`/ticket close`', value: '┃ Schließe dein aktuelles Ticket. Es wird archiviert und bleibt einsehbar.' },
              { name: '`/ticket status`', value: '┃ Zeigt eine Liste deiner letzten Tickets (inkl. Status und Betreff).' },
            ],
            footer: `Seite 5 ${Brand.dot} Support ${Brand.dot} ${Brand.footerText}`,
            timestamp: true,
          }),
        },
    {
      id: 'packages',
      embed: createBotEmbed({
        title: '📦  Meine Pakete',
        description: '> Verwalte deine eigenen Pakete als Hersteller.\n\n' + Brand.divider,
        color: 0x0099ff,
        fields: [
          { name: '`/mypackages list`', value: '┃ Alle deine Pakete anzeigen.' },
          { name: '`/mypackages info <paket>`', value: '┃ Detailansicht eines Pakets.' },
          { name: '`/mypackages delete <paket>`', value: '┃ Paket löschen (Soft-Delete).' },
          { name: '`/mypackages restore <paket>`', value: '┃ Gelöschtes Paket wiederherstellen.' },
          { name: '`/mypackages delete-file`', value: '┃ Einzelne Datei löschen (Dropdown).' },
        ],
        footer: `Seite 4 ${Brand.dot} Pakete ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 5: Giveaway ──
      // ── Seite 6: Giveaway ──
    {
      id: 'giveaway',
      embed: createBotEmbed({
        title: '🎉  Giveaway',
        description: '> Erstelle und verwalte Giveaways.\n\n' + Brand.divider,
        color: Colors.Giveaway,
        fields: [
          { name: '`/giveaway start <preis> <dauer>`', value: '┃ Neues Giveaway mit Preis und Dauer starten.' },
          { name: '`/giveaway enter <id>`', value: '┃ An einem Giveaway teilnehmen.' },
          { name: '`/giveaway info <id>`', value: '┃ Infos zu einem Giveaway anzeigen.' },
          { name: '`/giveaway end <id>`', value: '┃ Giveaway vorzeitig beenden.' },
        ],
        footer: `Seite 6 ${Brand.dot} Giveaway ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 6: Level & XP ──
      // ── Seite 7: Level & XP ──
    {
      id: 'level',
      embed: createBotEmbed({
        title: '⭐  Level & XP',
        description: '> Sammle XP durch Aktivität im Server.\n\n' + Brand.divider,
        color: Colors.Gold,
        fields: [
          { name: '`/level [user]`', value: '┃ Dein Level oder das eines anderen Users.' },
          { name: '`/leaderboard [seite]`', value: '┃ Top-User nach XP anzeigen.' },
          { name: '`/xp-config show`', value: '┃ *(Admin)* Aktuelle XP-Konfiguration ansehen.' },
          { name: '`/xp-config rate`', value: '┃ *(Admin)* XP-Raten und Multiplikator anpassen.' },
          { name: '`/xp-config xp-rolle-add` / `xp-rolle-remove` / `xp-rolle-list`', value: '┃ *(Admin)* Rollen festlegen, die XP sammeln dürfen.' },
          { name: '`/xp-config xp-channel-add` / `xp-channel-remove` / `xp-channel-list` / `xp-channel-clear`', value: '┃ *(Admin)* Strikte Kanal-Whitelist für XP.' },
          { name: '`/xp-config max-level` / `max-rolle`', value: '┃ *(Admin)* Endlevel + Belohnungsrolle festlegen.' },
          { name: '`/xp-config levelrole`', value: '┃ *(Admin)* Rolle für ein bestimmtes Level vergeben.' },
        ],
        footer: `Seite 7 ${Brand.dot} Level & XP ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 7: Umfragen ──
      // ── Seite 8: Umfragen ──
    {
      id: 'polls',
      embed: createBotEmbed({
        title: '📊  Umfragen',
        description: '> Erstelle Umfragen und stimme ab.\n\n' + Brand.divider,
        color: Colors.Poll,
        fields: [
          { name: '`/poll erstellen <titel> <optionen>`', value: '┃ Umfrage erstellen (Dauer: Min/Std/Tage/Wochen).' },
          { name: '`/poll abstimmen <id> <option>`', value: '┃ In einer Umfrage abstimmen.' },
          { name: '`/poll ergebnis <id>`', value: '┃ Aktuelle Ergebnisse anzeigen.' },
          { name: '`/poll beenden <id>`', value: '┃ Umfrage vorzeitig beenden.' },
        ],
        footer: `Seite 8 ${Brand.dot} Umfragen ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 8: Moderation ──
      // ── Seite 9: Moderation ──
    {
      id: 'moderation',
      embed: createBotEmbed({
        title: '🛡️  Moderation',
        description: '> Moderationstools (benötigt entsprechende Rechte).\n\n' + Brand.divider,
        color: Colors.Moderation,
        fields: [
          { name: '`/kick <user> <grund>`', value: '┃ Nutzer aus dem Server kicken.' },
          { name: '`/ban <user> <grund> [dauer]`', value: '┃ Nutzer bannen (optional: temporär).' },
          { name: '`/mute <user> <grund> [dauer]`', value: '┃ Nutzer stummschalten.' },
          { name: '`/warn <user> <grund>`', value: '┃ Nutzer verwarnen.' },
          { name: '`/appeal <case-id> <begründung>`', value: '┃ Beschwerde einreichen.' },
        ],
        footer: `Seite 9 ${Brand.dot} Moderation ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 10: Utility & Tools (Phase A + B) ──
    {
      id: 'utility',
      embed: createBotEmbed({
        title: '🧰  Utility & Tools',
        description: '> Persönliche Helfer: Status, Erinnerungen, Feedback, Self-Roles.\n\n' + Brand.divider,
        color: Colors.Info,
        fields: [
          { name: '`/ping`', value: '┃ Misst Bot- und WebSocket-Latenz.' },
          { name: '`/status`', value: '┃ Bot-Health: Uptime, DB-Roundtrip, Heap, OS.' },
          { name: '`/feedback <kategorie>`', value: '┃ Bug, Idee, Lob oder Sonstiges einreichen (Modal).' },
          { name: '`/erinnerung setzen <dauer> <einheit> <text>`', value: '┃ Erinnerung per DM oder Channel; auch wiederkehrend.' },
          { name: '`/erinnerung liste`', value: '┃ Deine aktiven Erinnerungen anzeigen.' },
          { name: '`/erinnerung loeschen <id>`', value: '┃ Erinnerung deaktivieren.' },
          { name: '`/help [category]`', value: '┃ Diese Command-Übersicht (mit Pagination).' },
        ],
        footer: `Seite 10 ${Brand.dot} Utility & Tools ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
    // ── Seite 11: KI & Auto ──
    {
      id: 'ai',
      embed: createBotEmbed({
        title: '🤖  KI & Auto',
        description: '> KI-gestützte Funktionen und Automatisierungen.\n\n' + Brand.divider,
        color: Colors.Teal,
        fields: [
          { name: '`/ai-trigger`', value: '┃ *(Admin)* Auto-Antworten auf Schlüsselwörter konfigurieren.' },
          { name: '`/translate-post`', value: '┃ *(Admin)* Beiträge automatisch übersetzen lassen.' },
          { name: '`/translate-post stuendlich/taeglich/woechentlich/monatlich`', value: '┃ Wiederkehrende Posts mit freier Stunden-/Minuten-/Tag-Wahl.' },
          { name: '`/welcome`', value: '┃ *(Admin)* Willkommens-Nachrichten mit Variablen.' },
          { name: '`/autorole`', value: '┃ *(Admin)* Rollen automatisch beim Beitritt vergeben.' },
          { name: '`/feed`', value: '┃ *(Admin)* RSS/News-Feeds in Channel posten.' },
        ],
        footer: `Seite 11 ${Brand.dot} KI & Auto ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    },
  ];

  // ── Admin-Seiten (nur für Admins) ──
  if (isAdmin) {
    pages.push({
      id: 'admin1',
      embed: createBotEmbed({
        title: '⚙️  Admin-Commands (1/2)',
        description: '> Erfordert Admin-Rolle in der Datenbank.\n\n' + Brand.divider,
        color: Colors.Admin,
        fields: [
          { name: '`/admin-approve <user>`', value: '┃ Hersteller-Anfrage annehmen.' },
          { name: '`/admin-deny <user>`', value: '┃ Hersteller-Anfrage ablehnen.' },
          { name: '`/admin-list-users`', value: '┃ Registrierte Nutzer anzeigen.' },
          { name: '`/admin-list-pakete`', value: '┃ Alle Pakete im System.' },
          { name: '`/admin-logs`', value: '┃ Live-Log-Stream.' },
          { name: '`/admin-delete <typ> <id>`', value: '┃ Soft-/Hard-Delete.' },
          { name: '`/admin-broadcast`', value: '┃ Broadcast-Nachricht.' },
          { name: '`/admin-stats`', value: '┃ Systemstatistiken.' },
          { name: '`/admin-validate`', value: '┃ Manuelle Validierung.' },
        ],
        footer: `Seite ${pages.length + 1} ${Brand.dot} Admin 1/2 ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    });
    pages.push({
      id: 'admin2',
      embed: createBotEmbed({
        title: '⚙️  Admin-Commands (2/2)',
        description: '> Weitere Admin-Commands.\n\n' + Brand.divider,
        color: Colors.Admin,
        fields: [
          { name: '`/admin-reset-password`', value: '┃ Passwort zurücksetzen.' },
          { name: '`/admin-toggle-upload`', value: '┃ Uploadrechte an/aus.' },
          { name: '`/admin-export`', value: '┃ Daten exportieren.' },
          { name: '`/admin-error-report`', value: '┃ Fehlerberichte.' },
          { name: '`/admin-config`', value: '┃ Bot-Konfiguration.' },
          { name: '`/admin-audit`', value: '┃ Audit-Log.' },
          { name: '`/admin-appeals`', value: '┃ Beschwerden verwalten.' },
          { name: '`/admin-security`', value: '┃ Sicherheitsübersicht.' },
          { name: '`/admin-monitor`', value: '┃ System-Monitoring.' },
          { name: '`/feed <aktion>`', value: '┃ Feed-Management.' },
          { name: '`/feed rolle-add` / `rolle-remove` / `rolle-list`', value: '┃ Rollen pingen wenn neuer Feed-Eintrag kommt.' },
          { name: '`/feed webhook-info` / `webhook-rotate`', value: '┃ Eingehende Webhook-URL + Secret fuer WEBHOOK-Feeds.' },
          { name: '`/selfrole`', value: '┃ Self-Role-Menüs (Buttons) erstellen/verwalten.' },
          { name: '`/xp-config`', value: '┃ XP-Raten, Whitelists, Level-Rollen.' },
          { name: '`/admin-feedback`', value: '┃ Feedback-Eintraege verwalten + Notification-Channel.' },
        ],
        footer: `Seite ${pages.length + 2} ${Brand.dot} Admin 2/2 ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    });
  }

  // ── DEV-Seiten (nur für Developer) ──
  if (isDev) {
    pages.push({
      id: 'developer',
      embed: createBotEmbed({
        title: '🔐  Developer-Commands',
        description: '> Erfordert `/dev-login` mit Passwort. Session: **2 Stunden**.\n\n' + Brand.divider,
        color: Colors.Dev,
        fields: [
          { name: '`/dev-login`', value: '┃ Developer-Bereich freischalten.' },
          { name: '`/dev-eval <check>`', value: '┃ Systemdiagnostik.' },
          { name: '`/dev-db <aktion>`', value: '┃ Datenbankmanagement.' },
          { name: '`/dev-reload`', value: '┃ Commands hot-reloaden.' },
          { name: '`/dev-admin <aktion>`', value: '┃ Admin-Rollen verwalten.' },
          { name: '`/dev-manufacturer <aktion>`', value: '┃ Hersteller verwalten.' },
        ],
        footer: `Seite ${pages.length + 1} ${Brand.dot} Developer ${Brand.dot} ${Brand.footerText}`,
        timestamp: true,
      }),
    });
  }

  return pages;
}

export default helpCommand;
