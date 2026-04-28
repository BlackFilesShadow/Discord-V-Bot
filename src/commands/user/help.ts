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
import { Colors, Brand } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';

/**
 * /help Command:
 * Info-Tafel mit Pagination — alle Commands mit Kurzerklärung.
 * Admin-Seiten nur für Admins sichtbar.
 * DEV-Seiten nur für authentifizierte Developer sichtbar.
 *
 * Struktur (Stand 2026-04):
 *  Seite 1 — Bot-Basics & Moderation
 *  Seite 2 — Level, XP & Rollen
 *  Seite 3 — Engagement & Community
 *  Seite 4 — Support & Kontakt
 *  Seite 5 — Hersteller & Pakete
 *  Seite 6 — KI & Automatisierung
 *  Seite 7 — (Admin) Hersteller-Verwaltung
 *  Seite 8 — (Admin) Bot-Verwaltung & Tickets
 *  Seite 9 — (Admin) Monitoring / Logs / Security
 *  Seite 10 — (Dev) Developer
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
          { name: 'Bot-Basics & Moderation', value: 'basics' },
          { name: 'Level, XP & Rollen', value: 'level' },
          { name: 'Engagement & Community', value: 'engagement' },
          { name: 'Support & Kontakt', value: 'support' },
          { name: 'Hersteller & Pakete', value: 'packages' },
          { name: 'KI & Automatisierung', value: 'ai' },
          { name: '(Admin) Hersteller-Verwaltung', value: 'admin-mfg' },
          { name: '(Admin) Bot-Verwaltung & Tickets', value: 'admin-bot' },
          { name: '(Admin) Monitoring & Security', value: 'admin-mon' },
          { name: '(Dev) Developer', value: 'developer' },
        )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ ephemeral: true });

    const { isAdmin, isDev } = await checkUserRoles(interaction.user.id);
    const pages = buildPages(isAdmin, isDev);

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
      time: 5 * 60 * 1000,
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
    new ButtonBuilder().setCustomId('help_first').setEmoji('⏮').setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId('help_prev').setEmoji('◀').setStyle(ButtonStyle.Primary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId('help_page_indicator').setLabel(`${current + 1} / ${total}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId('help_next').setEmoji('▶').setStyle(ButtonStyle.Primary).setDisabled(current >= total - 1),
    new ButtonBuilder().setCustomId('help_last').setEmoji('⏭').setStyle(ButtonStyle.Secondary).setDisabled(current >= total - 1),
  );
}

interface HelpPage { id: string; embed: EmbedBuilder; }

function footer(seite: number, label: string): string {
  return `Seite ${seite} ${Brand.dot} ${label} ${Brand.dot} ${Brand.footerText}`;
}

function buildPages(isAdmin: boolean, isDev: boolean): HelpPage[] {
  const pages: HelpPage[] = [];

  // ── Seite 1: Bot-Basics & Moderation ──────────────────────────
  pages.push({
    id: 'basics',
    embed: createBotEmbed({
      title: '🤖  Bot-Basics & Moderation',
      description: '> Grundfunktionen + Moderationstools für Server-Mods.\n\n' + Brand.divider,
      color: Colors.Primary,
      fields: [
        { name: '`/help [category]`', value: '┃ Diese Command-Übersicht (mit Pagination & Sprung).' },
        { name: '`/stell-dich-vor`', value: '┃ Bot stellt sich offiziell auf dem Server vor.' },
        { name: '🛡️ Moderation', value: Brand.divider },
        { name: '`/kick <user> <grund>`', value: '┃ Nutzer aus dem Server kicken.' },
        { name: '`/ban <user> <grund> [dauer]`', value: '┃ Nutzer bannen (optional temporär).' },
        { name: '`/mute <user> <grund> [dauer]`', value: '┃ Nutzer stummschalten.' },
        { name: '`/warn <user> <grund>`', value: '┃ Nutzer verwarnen.' },
        { name: '`/appeal <case-id> <begründung>`', value: '┃ Beschwerde gegen eine Mod-Aktion einreichen.' },
      ],
      footer: footer(1, 'Bot-Basics & Moderation'),
      timestamp: true,
    }),
  });

  // ── Seite 2: Level, XP & Rollen ───────────────────────────────
  pages.push({
    id: 'level',
    embed: createBotEmbed({
      title: '⭐  Level, XP & Rollen',
      description: '> Sammle XP durch Aktivität, hol dir Rollen oder bekomm sie automatisch.\n\n' + Brand.divider,
      color: Colors.Gold,
      fields: [
        { name: '🏆 Level / XP / Ranking', value: Brand.divider },
        { name: '`/level [user]`', value: '┃ Eigenes Level oder das eines anderen Users.' },
        { name: '`/leaderboard [seite]`', value: '┃ Top-User nach XP anzeigen.' },
        { name: '🎭 Rollen', value: Brand.divider },
        { name: '`/autorole`', value: '┃ *(Server-Admin)* Automatische Rollenvergabe (Beitritt, Reaktion, Level…).' },
        { name: '`/selfrole`', value: '┃ *(Server-Admin)* Self-Role-Menüs mit Buttons erstellen.' },
      ],
      footer: footer(2, 'Level, XP & Rollen'),
      timestamp: true,
    }),
  });

  // ── Seite 3: Engagement & Community ───────────────────────────
  pages.push({
    id: 'engagement',
    embed: createBotEmbed({
      title: '📅  Engagement & Community',
      description: '> Umfragen, Giveaways, Erinnerungen, Begrüßung, Feeds & mehrsprachige Posts.\n\n' + Brand.divider,
      color: Colors.Info,
      fields: [
        { name: '`/poll erstellen`', value: '┃ Umfrage erstellen (Min/Std/Tage/Wochen Laufzeit).' },
        { name: '`/poll abstimmen` / `ergebnis` / `beenden`', value: '┃ Teilnehmen, Stand sehen, vorzeitig beenden.' },
        { name: '`/giveaway start <preis> <dauer>`', value: '┃ Giveaway starten + per `/giveaway enter <id>` mitmachen.' },
        { name: '`/erinnerung setzen <dauer> <einheit> <text>`', value: '┃ Persönlicher Reminder (auch wiederkehrend).' },
        { name: '`/welcome`', value: '┃ *(Server-Admin)* Willkommens-Nachrichten mit Variablen + AI.' },
        { name: '`/feed`', value: '┃ *(Server-Admin)* RSS / News / Webhook-Feeds in einen Channel posten.' },
        { name: '`/translate-post`', value: '┃ *(Admin)* Auto-Übersetzen + Posten in 10 Sprachen, auch geplant.' },
      ],
      footer: footer(3, 'Engagement & Community'),
      timestamp: true,
    }),
  });

  // ── Seite 4: Support & Kontakt ────────────────────────────────
  pages.push({
    id: 'support',
    embed: createBotEmbed({
      title: '🎟️  Support & Kontakt',
      description: '> Sprich den Owner an, sende Feedback oder schalte den Developer-Bereich frei.\n\n' + Brand.divider,
      color: Colors.Info,
      fields: [
        { name: '`/ticket open <betreff> <nachricht>`', value: '┃ Ticket beim Owner öffnen — Owner wird per DM benachrichtigt.' },
        { name: '`/ticket close`', value: '┃ Eigenes Ticket schließen (bleibt archiviert + einsehbar).' },
        { name: '`/ticket status`', value: '┃ Liste deiner letzten Tickets (mit Status & Betreff).' },
        { name: '`/feedback <kategorie>`', value: '┃ Bug, Idee, Lob oder Sonstiges einreichen (Modal).' },
        { name: '`/dev-login`', value: '┃ 🔐 Developer-Bereich freischalten (Passwort + 2h-Session).' },
      ],
      footer: footer(4, 'Support & Kontakt'),
      timestamp: true,
    }),
  });

  // ── Seite 5: Hersteller & Pakete ──────────────────────────────
  pages.push({
    id: 'packages',
    embed: createBotEmbed({
      title: '📦  Hersteller & Pakete',
      description: '> Werde Hersteller, lade Dateien hoch, suche & lade andere Pakete.\n\n' + Brand.divider,
      color: Colors.Primary,
      fields: [
        { name: '`/register manufacturer`', value: '┃ Hersteller-Anfrage an den Admin senden.' },
        { name: '`/register verify <password>`', value: '┃ Einmal-Passwort (OTP) eingeben & freischalten.' },
        { name: '`/upload <paketname> <datei> [...]`', value: '┃ *(Hersteller)* Bis zu **10 Dateien** gleichzeitig hochladen.' },
        { name: '`/mypackages list` / `info` / `delete` / `restore` / `delete-file`', value: '┃ *(Hersteller)* Eigene Pakete & Dateien verwalten.' },
        { name: '`/search <suchbegriff>`', value: '┃ Pakete, Dateien oder Hersteller durchsuchen.' },
        { name: '`/download`', value: '┃ Hersteller wählen → Datei aussuchen & herunterladen.' },
      ],
      footer: footer(5, 'Hersteller & Pakete'),
      timestamp: true,
    }),
  });

  // ── Seite 6: KI & Automatisierung ─────────────────────────────
  pages.push({
    id: 'ai',
    embed: createBotEmbed({
      title: '🧠  KI & Automatisierung',
      description: '> AI-Chat, Auto-Reply-Trigger, Wissens-Snippets & Provider-Management.\n\n' + Brand.divider,
      color: Colors.Teal,
      fields: [
        { name: '`/ai`', value: '┃ AI-Chat (Groq → Gemini Fallback, RAG, Web-Suche).' },
        { name: '`/ai-trigger`', value: '┃ *(Admin)* Auto-Antworten auf Schlüsselwörter konfigurieren.' },
        { name: '`/admin-knowledge`', value: '┃ *(Admin)* Server-Wissens-Snippets für die AI pflegen.' },
        { name: '`/admin-aimodels`', value: '┃ *(Admin)* AI-Provider-Health, Reihenfolge & Live-Probe.' },
      ],
      footer: footer(6, 'KI & Automatisierung'),
      timestamp: true,
    }),
  });

  // ── ADMIN-Seiten (nur sichtbar wenn isAdmin) ──────────────────
  if (isAdmin) {
    pages.push({
      id: 'admin-mfg',
      embed: createBotEmbed({
        title: '👥  (Admin) Hersteller-Verwaltung',
        description: '> Anfragen prüfen, Pakete validieren, Uploadrechte & Passwörter verwalten.\n\n' + Brand.divider,
        color: Colors.Admin,
        fields: [
          { name: '`/admin-approve <user>`', value: '┃ Hersteller-Anfrage annehmen.' },
          { name: '`/admin-deny <user>`', value: '┃ Hersteller-Anfrage ablehnen.' },
          { name: '`/admin-list-users`', value: '┃ Alle Nutzer & Hersteller anzeigen.' },
          { name: '`/admin-list-pakete`', value: '┃ Alle Pakete & Inhalte.' },
          { name: '`/admin-validate`', value: '┃ Pakete oder Dateien manuell (re-)validieren.' },
          { name: '`/admin-delete <typ> <id>`', value: '┃ Pakete/Dateien löschen oder wiederherstellen.' },
          { name: '`/admin-toggle-upload`', value: '┃ Uploadrechte eines Users temporär entziehen / wiederherstellen.' },
          { name: '`/admin-reset-password`', value: '┃ Passwort/Token eines Users zurücksetzen.' },
        ],
        footer: footer(pages.length + 1, 'Admin · Hersteller-Verwaltung'),
        timestamp: true,
      }),
    });

    pages.push({
      id: 'admin-bot',
      embed: createBotEmbed({
        title: '⚙️  (Admin) Bot-Verwaltung & Tickets',
        description: '> Konfiguration, Broadcast, Tickets, Feedback, Appeals.\n\n' + Brand.divider,
        color: Colors.Admin,
        fields: [
          { name: '`/admin-config`', value: '┃ Bot-Konfiguration live anpassen.' },
          { name: '`/admin-broadcast`', value: '┃ Broadcast-Nachricht an alle Nutzer oder Hersteller.' },
          { name: '`/admin-tickets`', value: '┃ Tickets verwalten und schließen.' },
          { name: '`/admin-feedback`', value: '┃ Eingereichtes Feedback verwalten + Notification-Channel.' },
          { name: '`/admin-appeals`', value: '┃ Moderations-Appeals verwalten.' },
        ],
        footer: footer(pages.length + 1, 'Admin · Bot-Verwaltung'),
        timestamp: true,
      }),
    });

    pages.push({
      id: 'admin-mon',
      embed: createBotEmbed({
        title: '📊  (Admin) Monitoring / Logs / Security',
        description: '> System-Health, Audit, Sicherheits-Events & Backups.\n\n' + Brand.divider,
        color: Colors.Admin,
        fields: [
          { name: '`/admin-stats`', value: '┃ System- und Nutzungsstatistiken.' },
          { name: '`/admin-monitor`', value: '┃ Live-Monitoring aller Komponenten.' },
          { name: '`/admin-logs`', value: '┃ Live-Logs & Aktionsprotokoll.' },
          { name: '`/admin-audit`', value: '┃ Audit-Log + Compliance-Check.' },
          { name: '`/admin-security`', value: '┃ Security-Events & IP-Management.' },
          { name: '`/admin-error-report`', value: '┃ Fehlerberichte & Security-Events anzeigen.' },
          { name: '`/admin-export`', value: '┃ Daten exportieren (Backup, Analyse, Compliance).' },
        ],
        footer: footer(pages.length + 1, 'Admin · Monitoring & Security'),
        timestamp: true,
      }),
    });
  }

  // ── DEVELOPER-Seite (nur nach /dev-login) ─────────────────────
  if (isDev) {
    pages.push({
      id: 'developer',
      embed: createBotEmbed({
        title: '🔐  Developer',
        description: '> Erfordert `/dev-login` mit Passwort. Session: **2 Stunden**.\n\n' + Brand.divider,
        color: Colors.Dev,
        fields: [
          { name: '`/dev-admin <aktion>`', value: '┃ Admin-Rollen & DB-Permissions verwalten.' },
          { name: '`/dev-manufacturer <aktion>`', value: '┃ Hersteller verwalten (Status, Reset, Cleanup).' },
          { name: '`/dev-db <aktion>`', value: '┃ Datenbank-Management (Migrations, Inspect, Cleanup).' },
          { name: '`/dev-eval <check>`', value: '┃ Diagnostik & Systemcheck.' },
          { name: '`/dev-reload`', value: '┃ Commands hot-reloaden (ohne Neustart).' },
          { name: '`/ping`', value: '┃ Bot- und WebSocket-Latenz.' },
          { name: '`/status`', value: '┃ Bot-Status, Uptime, DB-Roundtrip, Heap, OS.' },
          { name: '`/xp-config`', value: '┃ XP-System konfigurieren (Raten, Rollen, Max-Level, Whitelists).' },
        ],
        footer: footer(pages.length + 1, 'Developer'),
        timestamp: true,
      }),
    });
  }

  return pages;
}

export default helpCommand;
