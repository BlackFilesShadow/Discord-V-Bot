import { config } from '../config';
import { BOT_DEVELOPER } from '../modules/ai/botIdentity';

/**
 * Kanonische, nutzerseitige Selbstbeschreibung von V-Bot Prime.
 * `/stell-dich-vor` und der Mention-Responder verwenden dieselbe Quelle.
 */
export const BOT_PRODUCT_NAME = 'V-Bot Prime' as const;

export function currentUploadLimitMiB(): number {
  return Math.max(1, Math.floor(config.upload.maxFileSizeBytes / 1024 / 1024));
}

export function buildBotAboutText(): string {
  const uploadMiB = currentUploadLimitMiB();
  return [
    `🤖 **${BOT_PRODUCT_NAME} – Community, DayZ & Automation in einem System**`,
    '',
    `Ich bin **${BOT_PRODUCT_NAME}**, entwickelt von **${BOT_DEVELOPER}**. Ich verbinde Discord-Community-Funktionen, DayZ/Nitrado-Verwaltung, Economy und ein geschuetztes Web-Dashboard in einem gemeinsamen System.`,
    '',
    '🎮 **DayZ & Nitrado** – mehrere Gameserver pro Guild mit sauber getrenntem Server-Scope, echte Remote-Whitelist-/Ban-Abgleiche und robuste Sync-Lebenszyklen.',
    '🛡️ **Moderation & Community** – Moderation, Tickets, Appeals, Giveaways, Polls, Reminder, XP/Level und Guild-weite Fraktionen mit abgesicherten Race-/Fehlerpfaden.',
    '💰 **Economy & Casino** – servergescopte Bank-/Wallet-Funktionen, sichere Spieler-Verknuepfung sowie Casino mit nachvollziehbaren, korrekt modellierten Spielregeln.',
    `📦 **Hersteller-System** – XML/JSON-Pakete mit bis zu 10 Dateien pro /upload, aktuell max. ${uploadMiB} MiB je Datei; nur vollstaendig verifizierte Hersteller und VALID gepruefte Dateien werden freigegeben.`,
    '🌐 **Dashboard** – Serververwaltung sowie getrennte Bot-Admin- und DEV-Bereiche. Privilegierte technische Werkzeuge werden dort verwaltet statt als normale oeffentliche Slash-Commands.',
    '',
    'Mit `/help` siehst du den **oeffentlich freigegebenen Discord-Command-Katalog**. DEV-Funktionen und `/ai` bleiben in dieser Hilfe bewusst unsichtbar.',
  ].join('\n');
}

export function buildBotFeaturesText(): string {
  const uploadMiB = currentUploadLimitMiB();
  return [
    `🛠️ **${BOT_PRODUCT_NAME} – aktueller Funktionsumfang**`,
    '',
    '**🎮 DayZ & Nitrado**',
    '• Mehrere Nitrado-Gameserver pro Discord-Guild mit getrenntem Server-Scope',
    '• Whitelist-Antrag, direkter Add/Remove und echte Remote-Liste mit serverbezogenem Lifecycle',
    '• Server-Bans mit Remote-Abgleich, zeitgesteuertem Ablauf und getrennten Teilfehlern pro Server',
    '• ADM-V2-Live-Ingest und Postprocessing fuer Gameplay-Feeds, Sessions und Rewards',
    '',
    '**💰 Economy & Community**',
    '• Economy/Bank, Transfers und Spieler-Verknuepfung mit Gameserver-Scope',
    '• Casino mit korrektem Coinflip, Dice, Blackjack und Runden-Audit',
    '• XP/Level, Giveaways, Polls, Reminder, Tickets, Appeals und Feedback',
    '• Guild-weite Fraktionen mit Rollen-Synchronisierung',
    '',
    '**📦 Hersteller & Dateien**',
    '• Hersteller-Antrag und OTP-Verifizierung',
    `• /upload fuer bis zu 10 XML/JSON-Dateien; aktuell max. ${uploadMiB} MiB pro Datei`,
    '• /mypackages fuer eigene Paketverwaltung mit atomaren Datei-/Statistik-Aenderungen',
    '• Download nur aus aktiven Herstellerbereichen und nur fuer VALID gepruefte Dateien',
    '',
    '**🛡️ Sicherheit & Nachvollziehbarkeit**',
    '• Zentrale Permission-, RateLimit- und Step-up-Gates mit einheitlichen Status-Embeds',
    '• Audit-Logs, Security-Events und geschuetzte Exportwege',
    '• Poll-/Reminder-/Ticket-/Giveaway-Flows gegen parallele Doppelaktionen und falsche Erfolgszustaende gehaertet',
    '',
    '**🌐 Dashboard & sichtbare Commands**',
    '• Normale Server-Self-Service-Funktionen bleiben in Discord und/oder Dashboard verfuegbar',
    '• Bot-Admin- und DEV-Diagnostik liegen in geschuetzten Dashboard-Bereichen',
    '• Hersteller-Funktionen bleiben bewusst als privilegierte Discord-Slash-Commands erhalten',
    '• `/help` zeigt nur die oeffentlich freigegebene Command-Oberflaeche; DEV und `/ai` werden dort nicht angezeigt',
    '',
    `**Entwickler:** ${BOT_DEVELOPER}`,
  ].join('\n');
}
