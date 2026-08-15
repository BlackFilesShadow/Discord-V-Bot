import { config } from '../config';
import { BOT_DEVELOPER } from '../modules/ai/botIdentity';

/**
 * Kanonische, nutzerseitige Selbstbeschreibung von V-Bot Prime.
 *
 * `/stell-dich-vor` und der Mention-Responder verwenden dieselbe Quelle. So
 * koennen Funktionsumfang, Command-Architektur und Limits nicht getrennt
 * voneinander veralten.
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
    `Ich bin **${BOT_PRODUCT_NAME}**, entwickelt von **${BOT_DEVELOPER}**. Ich verbinde Discord-Community-Funktionen, KI, Nitrado/DayZ-Verwaltung und ein Web-Dashboard in einem gemeinsamen System.`,
    '',
    '🤖 **KI & Server-Kontext** – Multi-Provider-KI, Live-Recherche, RAG/Wissensbank und serverbezogener Kontext mit Schutz sensibler Bereiche.',
    '🎮 **DayZ & Nitrado** – mehrere Gameserver pro Guild, Whitelist/Berechtigungen, Server-Banns mit zeitgesteuertem Ablauf sowie ADM-V2-/Gameplay-Feed-Infrastruktur.',
    '💰 **Community-Systeme** – Economy/Bank, Casino, Fraktionen, XP/Level, Giveaways, Polls, Tickets, Appeals, Feedback und Moderation.',
    `📦 **Hersteller-System** – XML/JSON-Pakete mit bis zu 10 Dateien pro /upload, aktuell max. ${uploadMiB} MiB je Datei laut Server-Konfiguration, Validierung und Quarantäne.`,
    '🌐 **Dashboard** – Serververwaltung plus getrennte Bot-Admin- und DEV-Bereiche. Privilegierte Bot-Admin-/DEV-Werkzeuge werden dort verwaltet und nicht mehr als normale Discord-Slash-Commands angeboten.',
    '🏭 **Discord-Ausnahme Hersteller** – Hersteller-Workflows bleiben gezielt als Slash-Commands verfügbar.',
    '',
    'Mit `/help` siehst du den **aktuell wirklich geladenen Discord-Command-Katalog**. Bot-Admin- und DEV-Funktionen werden dort bewusst nicht offengelegt.',
  ].join('\n');
}

export function buildBotFeaturesText(): string {
  const uploadMiB = currentUploadLimitMiB();
  return [
    `🛠️ **${BOT_PRODUCT_NAME} – aktueller Funktionsumfang**`,
    '',
    '**🤖 KI & Wissen**',
    '• Multi-Provider-Fallback über Groq, Cerebras, OpenRouter, Gemini und OpenAI',
    '• Live-Web-Recherche für geeignete Faktfragen',
    '• Server-/Nutzerkontext, Conversation-Memory und Schutz privater Admin-/Mod-/Log-Bereiche',
    '• RAG/Wissensbank, Server-Persona und konfigurierbare AI-Trigger',
    '',
    '**🎮 DayZ & Nitrado**',
    '• Mehrere Nitrado-Gameserver pro Discord-Guild mit getrenntem Server-Scope',
    '• Whitelist-, Permission- und Verknüpfungsverwaltung',
    '• Server-Banns inkl. zeitgesteuertem Ablauf und automatischer Remote-Entfernung',
    '• ADM-V2-Live-Ingest und Postprocessing als kanonische Grundlage für Gameplay-Feeds, Sessions und Rewards',
    '• Deathfeed-/Baufeed-Konfiguration und serverbezogene ADM-Diagnose im Dashboard',
    '',
    '**💰 Economy & Community**',
    '• Economy/Bank, Transfers und Zinsverarbeitung mit Gameserver-Scope',
    '• Casino- und Fraktionsfunktionen',
    '• XP-/Level-System, Levelrollen, Giveaways und Polls',
    '• Tickets, Appeals, Feedback, Selfroles, Welcome und übersetzte Posts',
    '',
    '**📦 Hersteller & Dateien**',
    '• Hersteller-Antrag/Verifizierung und getrennte Paketbereiche',
    `• /upload für bis zu 10 XML/JSON-Dateien in einem Paket; aktuell max. ${uploadMiB} MiB pro Datei laut Server-Konfiguration`,
    '• /mypackages für die eigene Paketverwaltung',
    '• Validierung, Integritätsprüfung, Quarantäne, Soft-Delete und Audit-Logging',
    '',
    '**🛡️ Moderation, Sicherheit & Nachvollziehbarkeit**',
    '• Bann, Kick, Mute, Warnungen, Auto-Mod und Case-/Appeal-Verarbeitung',
    '• Rate-Limits, Audit-Logs, Security-Events und geschützte Exportwege',
    '• Prometheus-Metriken optional und nur mit Bearer-Token aktiviert',
    '',
    '**🌐 Dashboard statt privilegierter Slash-Commands**',
    '• Serverbezogene Self-Service-Funktionen liegen im normalen Dashboard',
    '• Bot-Admin-Werkzeuge liegen im geschützten Bot-Admin-Bereich',
    '• DEV-Diagnostik und sensible technische Aktionen liegen im DEV-Bereich; sensible Mutationen/Exporte verlangen echte Re-Authentisierung per TOTP oder DEV-Passwort',
    '• Hersteller-Funktionen sind die bewusste Ausnahme und bleiben in Discord',
    '',
    `**Entwickler:** ${BOT_DEVELOPER}`,
    'Tipp: `/help` wird aus der Live-Command-Registry aufgebaut und zeigt deshalb nur Commands, die Discord aktuell wirklich anbietet.',
  ].join('\n');
}
