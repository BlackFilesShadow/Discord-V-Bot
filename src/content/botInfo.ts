import { BOT_DEVELOPER } from '../modules/ai/botIdentity';

/**
 * Kanonische, nutzerseitige Selbstbeschreibung von V-Bot Prime.
 *
 * Diese Texte werden sowohl vom Slash-Command `/stell-dich-vor` als auch vom
 * Mention-Responder verwendet. Dadurch koennen Runtime-Antworten nicht mehr
 * unabhaengig voneinander veralten.
 *
 * WICHTIG: Privilegierte Bot-Admin-/DEV-Funktionen werden bewusst nur als
 * Dashboard-Bereiche beschrieben; ihre frueheren Slash-Namen werden hier nicht
 * erneut als verfuegbar dargestellt. Hersteller-Funktionen sind die explizite
 * Discord-Ausnahme.
 */
export const BOT_PRODUCT_NAME = 'V-Bot Prime' as const;

export const BOT_ABOUT_TEXT = [
  `🤖 **${BOT_PRODUCT_NAME} – Community, DayZ & Automation in einem System**`,
  '',
  `Ich bin **${BOT_PRODUCT_NAME}**, entwickelt von **${BOT_DEVELOPER}**. Ich verbinde Discord-Community-Funktionen, KI, Nitrado/DayZ-Verwaltung und ein Web-Dashboard in einem gemeinsamen System.`,
  '',
  '🤖 **KI & Server-Kontext** – Multi-Provider-KI, Web-Recherche, RAG/Wissensbank und serverbezogener Kontext mit Schutz sensibler Bereiche.',
  '🎮 **DayZ & Nitrado** – mehrere Gameserver pro Guild, Whitelist/Berechtigungen, Server-Banns mit zeitgesteuertem Ablauf sowie ADM-V2-/Gameplay-Feed-Infrastruktur.',
  '💰 **Community-Systeme** – Economy/Bank, Casino, Fraktionen, XP/Level, Giveaways, Polls, Tickets, Appeals, Feedback und Moderation.',
  '📦 **Hersteller-System** – XML/JSON-Pakete mit bis zu 10 Dateien pro Upload, standardmäßig max. 25 MB je Datei, Validierung und Quarantäne.',
  '🌐 **Dashboard** – Serververwaltung plus getrennte Bot-Admin- und DEV-Bereiche. Privilegierte Admin-/DEV-Werkzeuge werden dort verwaltet und nicht mehr als normale Discord-Slash-Commands angeboten.',
  '🏭 **Discord-Ausnahme Hersteller** – Hersteller-Workflows bleiben gezielt als Slash-Commands verfügbar.',
  '',
  'Mit `/help` siehst du den **aktuell wirklich geladenen Discord-Command-Katalog**. Bot-Admin- und DEV-Funktionen werden dort bewusst nicht offengelegt.',
].join('\n');

export const BOT_FEATURES_TEXT = [
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
  '• `/upload` für bis zu 10 XML/JSON-Dateien in einem Paket; standardmäßig max. 25 MB pro Datei',
  '• `/mypackages` für die eigene Paketverwaltung',
  '• Validierung, Integritätsprüfung, Quarantäne, Soft-Delete und Audit-Logging',
  '',
  '**🛡️ Moderation, Sicherheit & Nachvollziehbarkeit**',
  '• Bann, Kick, Mute, Warnungen, Auto-Mod und Case-/Appeal-Verarbeitung',
  '• Rate-Limits, Audit-Logs, Security-Events und geschützte Exportwege',
  '• Prometheus-Metriken optional und nur mit Bearer-Token aktiviert',
  '',
  '**🌐 Dashboard statt privilegierter Slash-Commands**',
  '• Server-Owner verwalten serverbezogene Funktionen im Self-Service-Dashboard',
  '• Bot-Admin-Werkzeuge liegen im geschützten Bot-Admin-Bereich',
  '• DEV-Diagnostik und sensible technische Aktionen liegen im DEV-Bereich; Mutationen/Exporte verlangen zusätzlich echte Re-Authentisierung per TOTP oder DEV-Passwort',
  '• Hersteller-Funktionen sind die bewusste Ausnahme und bleiben in Discord',
  '',
  `**Entwickler:** ${BOT_DEVELOPER}`,
  'Tipp: `/help` wird aus dem Live-Command-Registry aufgebaut und zeigt deshalb nur Commands, die Discord aktuell wirklich anbietet.',
].join('\n');
