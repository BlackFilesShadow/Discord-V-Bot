import {
  SlashCommandBuilder,
  ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
} from 'discord.js';
import { UserRole } from '@prisma/client';
import { Command } from '../../types';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { Colors, Brand } from '../../utils/embedDesign';
import { createBotEmbed } from '../../utils/embedUtil';
import { getDevSessionExpires } from '../../utils/devAuthStore';

/**
 * /help — Pagination-Tafel mit allen Commands.
 *
 * Sichtbarkeit:
 *   Public  : alle
 *   Admin   : DB-Rolle ADMIN | SUPER_ADMIN | DEVELOPER  oder Bot-Owner
 *   Dev     : DB-Rolle DEVELOPER + aktive /dev-login-Session  oder Bot-Owner
 *
 * Symbol-Bedeutung wird einmalig im SYM-Mapping unten und im
 * sichtbaren Legenden-Block (LEGEND) gepflegt.
 */

type SymbolKey = 'mod' | 'hersteller' | 'srv' | 'admin' | 'dev';
const SYM: Record<SymbolKey, string> = {
  mod:        '🛡️',
  hersteller: '🏭',
  srv:        '⚙️',
  admin:      '🔧',
  dev:        '🔐',
};

// Sichtbare Legende — EINE Quelle der Wahrheit, in jede Page-Description gespiegelt.
const LEGEND =
  `${SYM.mod} Discord-Mod · ${SYM.hersteller} Hersteller · ` +
  `${SYM.srv} Server-Admin (Discord-Perm) · ${SYM.admin} Bot-Admin (DB-Rolle) · ` +
  `${SYM.dev} Developer-Session`;

// Slug → Anzeige-Label für Sprung-Hinweis (vermeidet Roh-Slugs in der UI)
const CATEGORY_LABELS: Record<string, string> = {
  basics:      '🤖 Bot-Basics & Moderation',
  level:       '⭐ Level, XP & Rollen',
  engagement:  '📅 Engagement & Community',
  support:     '🎟️ Support & Kontakt',
  packages:    '📦 Hersteller & Pakete',
  ai:          '🧠 KI & Automatisierung',
  'admin-mfg': '🔧 Admin · Hersteller-Verwaltung',
  'admin-bot': '🔧 Admin · Bot-Verwaltung & Tickets',
  'admin-mon': '🔧 Admin · Monitoring & Security',
  developer:   '🔐 Developer',
};

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
          { name: '🤖 Bot-Basics & Moderation',          value: 'basics' },
          { name: '⭐ Level, XP & Rollen',               value: 'level' },
          { name: '📅 Engagement & Community',           value: 'engagement' },
          { name: '🎟️ Support & Kontakt',               value: 'support' },
          { name: '📦 Hersteller & Pakete',              value: 'packages' },
          { name: '🧠 KI & Automatisierung',             value: 'ai' },
          { name: '🔧 Admin · Hersteller-Verwaltung',    value: 'admin-mfg' },
          { name: '🔧 Admin · Bot-Verwaltung & Tickets', value: 'admin-bot' },
          { name: '🔧 Admin · Monitoring & Security',    value: 'admin-mon' },
          { name: '🔐 Developer',                        value: 'developer' },
        )
    ),

  execute: async (interaction: ChatInputCommandInteraction) => {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const { isAdmin, isDev } = await checkUserRoles(interaction.user.id);
    const pages = buildPages(isAdmin, isDev);

    // Direkt-Sprung zur gewünschten Kategorie (Hinweis bei Fehlschlag mit lesbarem Label)
    const requested = interaction.options.getString('category');
    let current = 0;
    let infoNotice: string | null = null;
    if (requested) {
      const idx = pages.findIndex(p => p.id === requested);
      if (idx >= 0) {
        current = idx;
      } else {
        const label = CATEGORY_LABELS[requested] ?? requested;
        infoNotice = `ℹ️ Die Kategorie **${label}** ist für dich nicht verfügbar — Übersicht wird angezeigt.`;
      }
    }

    const message = await interaction.editReply({
      content: infoNotice ?? '',
      embeds: [pages[current].embed],
      components: [buildButtons(current, pages.length)],
    });

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
          content: '', // Sprung-Hinweis nach erster Interaktion entfernen
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

  const dbUser = await prisma.user.findUnique({ where: { discordId: userId } });
  if (!dbUser) return { isAdmin: false, isDev: false };

  const adminRoles: UserRole[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.DEVELOPER];
  const isAdmin = adminRoles.includes(dbUser.role);

  // Dev-Session: global in DB (Multi-Shard). 
  const expires = await getDevSessionExpires(userId);
  const sessionValid = typeof expires === 'number' && expires > Date.now();
  const isDev = dbUser.role === UserRole.DEVELOPER && sessionValid;

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

interface HelpPage { id: string; label: string; embed: EmbedBuilder; }

/**
 * Erzeugt einen einheitlichen Field-Eintrag.
 *  perms: optionale Symbol-Liste (z.B. ['srv'] für ManageGuild)
 *  cmd:   z.B. '/welcome set'
 *  desc:  kurze Erklärung (eine Zeile)
 */
function row(cmd: string, desc: string, perms: SymbolKey[] = []): { name: string; value: string } {
  const prefix = perms.length ? perms.map(p => SYM[p]).join('') + ' ' : '';
  return {
    name: `${prefix}\`${cmd}\``,
    value: `┃ ${desc}`,
  };
}

function buildPages(isAdmin: boolean, isDev: boolean): HelpPage[] {
  const pages: HelpPage[] = [];

  // ── Seite 1: Bot-Basics & Moderation ──────────────────────────
  pages.push({
    id: 'basics',
    label: 'Bot-Basics & Moderation',
    embed: createBotEmbed({
      title: '🤖  Bot-Basics & Moderation',
      description:
        '> Allgemeine Bot-Commands für jeden — und Moderationstools für berechtigte Mods.\n' +
        `> ${LEGEND}\n\n` +
        Brand.divider,
      color: Colors.Primary,
      fields: [
        row('/help [category]',         'Diese Übersicht (mit Pagination & Sprung).'),
        row('/stell-dich-vor',          'Bot stellt sich auf dem Server vor.'),
        row('/kick <user> <grund>',                  'Nutzer aus dem Server entfernen.', ['mod']),
        row('/ban <user> <grund> [dauer]',           'Nutzer bannen (optional temporär).', ['mod']),
        row('/mute <user> <grund> [dauer]',          'Nutzer per Timeout stummschalten.', ['mod']),
        row('/warn <user> <grund>',                  'Verwarnung mit Eintrag im Mod-Log.', ['mod']),
        row('/appeal <case-id> <begründung>',        'Beschwerde gegen eine Mod-Aktion einreichen.'),
      ],
      timestamp: true,
    }),
  });

  // ── Seite 2: Level, XP & Rollen ───────────────────────────────
  pages.push({
    id: 'level',
    label: 'Level, XP & Rollen',
    embed: createBotEmbed({
      title: '⭐  Level, XP & Rollen',
      description: '> Sammle XP, sieh die Bestenliste und verwalte automatische oder selbstwählbare Rollen.\n\n' + Brand.divider,
      color: Colors.Gold,
      fields: [
        row('/level [user]',                       'Eigenes Level oder das eines anderen Users.'),
        row('/leaderboard [sortierung] [seite]',   'Top-User nach XP (auch als Live-Feed möglich).'),
        row('/xp-config show|rate|levelrole|max-level|max-rolle|xp-rolle-…|xp-channel-…', 'XP-System konfigurieren (Raten, Level-Rollen, Filter).', ['srv']),
      ],
      timestamp: true,
    }),
  });

  // ── Seite 3: Engagement & Community ───────────────────────────
  pages.push({
    id: 'engagement',
    label: 'Engagement & Community',
    embed: createBotEmbed({
      title: '📅  Engagement & Community',
      description: '> Umfragen, Giveaways, Erinnerungen und Begrüßung.\n\n' + Brand.divider,
      color: Colors.Info,
      fields: [
        row('/poll erstellen|abstimmen|ergebnis|beenden|liste',  'Umfragen mit Mehrfachauswahl & Laufzeit (Min–Wochen).'),
        row('/giveaway start|enter|info|end|list',               'Giveaways mit Preis, Dauer, Mindestrolle, Emoji.'),
        row('/erinnerung setzen|liste|loeschen',                 'Persönlicher Reminder per DM oder Channel (auch wiederkehrend).'),
      ],
      timestamp: true,
    }),
  });

  // ── Seite 4: Support & Kontakt ────────────────────────────────
  pages.push({
    id: 'support',
    label: 'Support & Kontakt',
    embed: createBotEmbed({
      title: '🎟️  Support & Kontakt',
      description: '> Sprich den Owner direkt an, sende Feedback oder schalte den Developer-Bereich frei.\n\n' + Brand.divider,
      color: Colors.Info,
      fields: [
        row('/ticket open <betreff> <nachricht>', 'Ticket beim Owner öffnen — Owner wird per DM benachrichtigt.'),
        row('/ticket close',                      'Eigenes aktives Ticket schließen (bleibt archiviert).'),
        row('/ticket status',                     'Liste deiner letzten Tickets.'),
        row('/feedback <kategorie>',              'Bug, Idee, Lob oder Sonstiges einreichen (Modal).'),
        row('/ping',                              'Bot- und WebSocket-Latenz prüfen.', ['srv']),
        row('/status',                            'Bot-Status: Uptime, DB, Heap, Betriebssystem.', ['srv']),
        row('/dev-login',                         'Developer-Bereich freischalten (Passwort-Modal, 2 h Session).', ['admin']),
      ],
      timestamp: true,
    }),
  });

  // ── Seite 5: Hersteller & Pakete ──────────────────────────────
  pages.push({
    id: 'packages',
    label: 'Hersteller & Pakete',
    embed: createBotEmbed({
      title: '📦  Hersteller & Pakete',
      description: '> Werde Hersteller, lade Dateien hoch oder finde & lade andere Pakete.\n\n' + Brand.divider,
      color: Colors.Primary,
      fields: [
        row('/register manufacturer [reason]',                          'Hersteller-Anfrage an den Admin senden.'),
        row('/register verify <password>',                              'Einmal-Passwort (OTP) eingeben & freischalten.'),
        row('/upload <paketname> <datei> [datei2 …]',                  'Bis zu 10 Dateien pro Paket hochladen (XML/JSON, max 2 GB).', ['hersteller']),
        row('/mypackages list|info|delete|restore|delete-file',         'Eigene Pakete und Dateien verwalten.', ['hersteller']),
        row('/search <query> [dateityp]',                               'Pakete, Dateien oder Hersteller durchsuchen.'),
        row('/download',                                                'Hersteller wählen → Datei aussuchen → Download.'),
      ],
      timestamp: true,
    }),
  });

  // ── Seite 6: KI & Automatisierung ─────────────────────────────
  pages.push({
    id: 'ai',
    label: 'KI & Automatisierung',
    embed: createBotEmbed({
      title: '🧠  KI & Automatisierung',
      description: '> AI-Chat für alle, plus Trigger, Wissens-Snippets und Provider-Verwaltung.\n\n' + Brand.divider,
      color: Colors.Teal,
      fields: [
        row('/ai ask|sentiment|toxicity|translate', 'AI-Chat (Groq → Gemini Fallback, RAG, Web-Suche).'),
        row('/ai-trigger add|list|remove|clear',    'Auto-Antworten auf Schlüsselwörter (Keyword/Regex/Mention).', ['admin']),
        row('/admin-knowledge add|list|remove|persona', 'Server-Wissens-Snippets für die AI pflegen.', ['admin']),
        row('/admin-aimodels status|order|probe|reset', 'AI-Provider-Health, Reihenfolge, Live-Probe.', ['admin']),
      ],
      timestamp: true,
    }),
  });

  // ── ADMIN-Seiten (nur sichtbar wenn isAdmin) ──────────────────
  if (isAdmin) {
    pages.push({
      id: 'admin-mfg',
      label: 'Admin · Hersteller-Verwaltung',
      embed: createBotEmbed({
        title: '🔧  Admin · Hersteller-Verwaltung',
        description: '> Anfragen prüfen, Pakete validieren, Uploadrechte und Passwörter verwalten.\n\n' + Brand.divider,
        color: Colors.Admin,
        fields: [
          row('/admin-list-pakete [status] [user] [seite]',                'Alle Pakete im System.', ['admin']),
          row('/admin-validate paket|datei|quarantaene',                   'Pakete oder Dateien manuell (re-)validieren.', ['admin']),
          row('/admin-delete paket|datei|restore|bulk',                    'Pakete oder Dateien löschen / wiederherstellen.', ['admin']),
        ],
        timestamp: true,
      }),
    });

    pages.push({
      id: 'admin-bot',
      label: 'Admin · Bot-Verwaltung',
      embed: createBotEmbed({
        title: '🔧  Admin · Bot-Verwaltung & Tickets',
        description: '> Konfiguration, Broadcast, Tickets, Feedback und Mod-Appeals.\n\n' + Brand.divider,
        color: Colors.Admin,
        fields: [
          row('/admin-config anzeigen|setzen|loeschen',     'Bot-Konfiguration live anpassen.', ['admin']),
          row('/admin-feedback liste|zeigen|status|notiz|channel', 'Feedback verwalten + Notification-Channel.', ['admin']),
        ],
        timestamp: true,
      }),
    });

    pages.push({
      id: 'admin-mon',
      label: 'Admin · Monitoring & Security',
      embed: createBotEmbed({
        title: '🔧  Admin · Monitoring / Logs / Security',
        description: '> System-Health, Audit, Sicherheits-Events und Datenexporte.\n\n' + Brand.divider,
        color: Colors.Admin,
        fields: [
          row('/admin-stats',                                      'System- und Nutzungsstatistiken.', ['admin']),
          row('/admin-monitor',                                    'Live-Monitoring aller Komponenten.', ['admin']),
          row('/admin-logs [filter] [anzahl] [user]',              'Live-Logs & Aktionsprotokoll.', ['admin']),
          row('/admin-audit suchen|volltext|compliance|export',    'Audit-Log + Compliance-Check.', ['admin']),
          row('/admin-security events|blacklist|whitelist|resolve','Security-Events & IP-Management.', ['admin']),
          row('/admin-error-report [schwere] [ungeloest] [anzahl]','Fehlerberichte anzeigen.', ['admin']),
          row('/admin-export pakete|logs|nutzer',                  'Backup, Audit-Export, GDPR-Datenexport.', ['admin']),
        ],
        timestamp: true,
      }),
    });
  }

  // ── DEVELOPER-Seite (nur nach /dev-login) ─────────────────────
  if (isDev) {
    pages.push({
      id: 'developer',
      label: 'Developer',
      embed: createBotEmbed({
        title: '🔐  Developer',
        description: '> Erfordert `/dev-login` mit Passwort. Session läuft **2 Stunden**.\n\n' + Brand.divider,
        color: Colors.Dev,
        fields: [
          row('/dev-admin add|remove|list',          'Admin-Rollen verwalten.', ['dev']),
          row('/dev-manufacturer remove|list',       'Hersteller komplett entfernen / auflisten.', ['dev']),
          row('/dev-db <action> [query]',            'Datenbank-Management (Migrations, Inspect, Cleanup).', ['dev']),
          row('/dev-eval <check>',                   'Diagnostik & Systemcheck.', ['dev']),
          row('/dev-reload [scope]',                 'Commands hot-reloaden (ohne Neustart).', ['dev']),
        ],
        timestamp: true,
      }),
    });
  }

  // Footer mit korrekter Seitenzahl NACH allen pushes setzen — reihenfolge-robust
  pages.forEach((p, i) => {
    p.embed.setFooter({ text: pageFooter(i + 1, p.label) });
  });

  return pages;
}

function pageFooter(seite: number, label: string): string {
  return `Seite ${seite} ${Brand.dot} ${label} ${Brand.dot} ${Brand.footerText}`;
}

export default helpCommand;
