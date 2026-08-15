import { config } from '../../config';

/**
 * Oeffentlicher/benutzerrelevanter Command-Katalog fuer die AI.
 *
 * Diese Datei beschreibt ausschliesslich Commands, die nach der
 * Dashboard-Migration weiterhin bei Discord registriert werden. Bot-Admin- und
 * DEV-Command-Center-Funktionen sind Dashboard-only und duerfen von der AI
 * nicht als Slash-Commands ausgegeben werden. Hersteller-Funktionen sind die
 * ausdrueckliche Ausnahme und bleiben in Discord.
 */
export interface PublicCommandDoc {
  name: string;
  short: string;
  details: string;
  examples?: string[];
  requires?: string;
  limits?: string;
  related?: string[];
}

const uploadMiB = Math.max(1, Math.floor(config.upload.maxFileSizeBytes / 1024 / 1024));

export const GLOSSARY: { term: string; explanation: string }[] = [
  { term: 'GUID', explanation: 'Eindeutige interne ID fuer getrennte Hersteller-Bereiche.' },
  { term: 'OTP', explanation: 'Einmal-Passwort zur Hersteller-Verifikation; standardmaessig 30 Minuten gueltig.' },
  { term: 'Soft-Delete', explanation: 'Als geloescht markiert, aber weiterhin wiederherstellbar.' },
  { term: 'Hersteller', explanation: 'Verifizierter User, der die Hersteller-Slash-Funktionen /upload und /mypackages nutzen darf.' },
  { term: 'Gameserver-Slot', explanation: 'Ein mit der Discord-Guild verknuepfter Nitrado-DayZ-Server. Serveraktionen bleiben pro Slot getrennt.' },
  { term: 'XP-Cooldown', explanation: 'Mindestabstand zwischen XP-Vergaben als Anti-Spam-Schutz.' },
];

export const PUBLIC_COMMAND_CATALOG: PublicCommandDoc[] = [
  // Hilfe / Bot
  {
    name: '/help',
    short: 'Zeigt den aktuell geladenen Discord-Command-Katalog.',
    details: 'Die Hilfe wird aus der Live-Command-Registry aufgebaut. Bot-Admin- und DEV-Funktionen werden im Web-Dashboard verwaltet und dort nicht als Slash-Commands dargestellt.',
    examples: ['/help'],
  },
  {
    name: '/stell-dich-vor',
    short: 'Zeigt eine aktuelle Kurzvorstellung von V-Bot.',
    details: 'Fasst die wichtigsten Nutzer-, DayZ-/Nitrado-, Economy- und Herstellerfunktionen zusammen.',
  },

  // AI
  {
    name: '/ai ask',
    short: 'Stellt V-Bot eine Wissensfrage.',
    details: 'Nutzt Multi-Provider-AI, Serverkontext wo passend und bei aktuellen Faktfragen die konfigurierte Live-Recherche.',
    examples: ['/ai ask frage:Wie funktioniert das XP-System?'],
  },
  { name: '/ai sentiment', short: 'Analysiert die Stimmung eines Textes.', details: 'Liefert positiv, neutral oder negativ mit Score.' },
  { name: '/ai toxicity', short: 'Prueft Text auf toxische Inhalte.', details: 'Klassifiziert u.a. Hate, Harassment, Violence, Sexual und Spam.' },
  { name: '/ai translate', short: 'Uebersetzt Text in eine Zielsprache.', details: 'Uebersetzt den angegebenen Text ueber die AI-Provider.' },

  // Hersteller
  {
    name: '/register manufacturer',
    short: 'Beantragt den Hersteller-Status.',
    details: 'Erstellt eine Hersteller-Anfrage. Nach Freigabe wird die Verifikation ueber ein zeitlich begrenztes OTP abgeschlossen.',
    related: ['/register verify', '/upload'],
  },
  {
    name: '/register verify',
    short: 'Schliesst die Hersteller-Verifikation mit OTP ab.',
    details: 'Aktiviert nach erfolgreicher OTP-Pruefung den Hersteller-Zugang.',
  },
  {
    name: '/upload',
    short: `Laedt XML/JSON-Dateien in ein Hersteller-Paket hoch (standardmaessig bis ${uploadMiB} MiB pro Datei).`,
    details: 'Nur fuer verifizierte Hersteller. Bis zu 10 Attachments werden in einem Aufruf verarbeitet; jede Datei wird gegen das konfigurierte Groessenlimit und die Upload-Validierung geprueft.',
    requires: 'verifizierter Hersteller',
    limits: `max. 10 Dateien pro Aufruf; aktuelles konfiguriertes Limit ${uploadMiB} MiB pro Datei; erlaubte Endungen: ${config.upload.allowedExtensions.join(', ')}`,
    related: ['/mypackages list'],
  },
  { name: '/mypackages list', short: 'Listet eigene Hersteller-Pakete.', details: 'Zeigt die eigenen Pakete und deren Status.', requires: 'verifizierter Hersteller' },
  { name: '/mypackages info', short: 'Zeigt Details zu einem eigenen Paket.', details: 'Zeigt Paket- und Dateiinformationen.', requires: 'verifizierter Hersteller' },
  { name: '/mypackages delete', short: 'Loescht ein eigenes Paket per Soft-Delete.', details: 'Das Paket kann spaeter wiederhergestellt werden.', requires: 'verifizierter Hersteller' },
  { name: '/mypackages restore', short: 'Stellt ein Soft-Deleted Paket wieder her.', details: 'Aktiviert ein zuvor geloeschtes eigenes Paket wieder.', requires: 'verifizierter Hersteller' },
  { name: '/mypackages delete-file', short: 'Entfernt einzelne Dateien aus einem eigenen Paket.', details: 'Die Datei wird innerhalb des eigenen Hersteller-Bereichs ausgewaehlt.', requires: 'verifizierter Hersteller' },

  // Pakete / Feedback / Reminder
  { name: '/search', short: 'Sucht veroeffentlichte Pakete.', details: 'Sucht nach Paketdaten und verfuegbaren Dateien.' },
  { name: '/download', short: 'Laedt freigegebene Hersteller-Dateien oder Pakete herunter.', details: 'Fuehrt interaktiv durch Hersteller, Paket und Datei/ZIP und protokolliert Downloads.' },
  { name: '/feedback', short: 'Sendet Bug-Reports, Ideen, Lob oder sonstiges Feedback.', details: 'Oeffnet ein Modal und speichert das Feedback fuer die Bot-Administration.', limits: '30 Sekunden Command-Cooldown' },
  {
    name: '/erinnerung setzen',
    short: 'Legt eine persoenliche Erinnerung an.',
    details: 'Zustellung per DM oder aktuellem Textkanal; optional wiederkehrend.',
    limits: 'max. 25 aktive Reminder pro User; 5 Sekunden bis 1 Jahr; wiederkehrend mindestens 1 Minute',
    related: ['/erinnerung liste', '/erinnerung loeschen'],
  },
  { name: '/erinnerung liste', short: 'Zeigt eigene aktive Erinnerungen.', details: 'Listet die persoenlichen Reminder.' },
  { name: '/erinnerung loeschen', short: 'Loescht eine eigene Erinnerung.', details: 'Verwendet die Reminder-ID aus /erinnerung liste.' },

  // XP / Community
  { name: '/level', short: 'Zeigt Level und XP.', details: 'Zeigt den eigenen oder optional den Levelstand eines anderen Users.' },
  { name: '/leaderboard', short: 'Zeigt die XP-Bestenliste der Guild.', details: 'Stellt die Server-Rangliste anhand der konfigurierten XP-Daten dar.' },
  { name: '/giveaway', short: 'Verwaltet Giveaways.', details: 'Start, Teilnahme, Info, Liste und Beenden laufen ueber die Subcommands des aktuell geladenen Giveaway-Commands.' },
  { name: '/poll', short: 'Verwaltet Umfragen.', details: 'Erstellen, abstimmen, Ergebnis, Liste und Beenden laufen ueber die Poll-Subcommands.' },
  { name: '/ticket open', short: 'Oeffnet ein Support-Ticket.', details: 'Erstellt eine private Support-Anfrage; der bestehende Ticket-Flow kann anschliessend per Bot/DM weitergefuehrt werden.', related: ['/ticket close', '/ticket status'] },
  { name: '/ticket close', short: 'Schliesst das eigene aktive Ticket.', details: 'Beendet den aktiven Support-Flow.' },
  { name: '/ticket status', short: 'Zeigt den Status eigener Tickets.', details: 'Listet die letzten Support-Tickets und deren Status.' },

  // Discord-Moderation
  { name: '/kick', short: 'Kickt einen Nutzer.', details: 'Entfernt den Nutzer aus der Guild und protokolliert die Moderationsaktion.', requires: 'entsprechende Moderationsberechtigung' },
  { name: '/ban', short: 'Bannt einen Discord-Nutzer.', details: 'Discord-Moderationsban; getrennt von den Nitrado-Server-Bans.', requires: 'entsprechende Moderationsberechtigung' },
  { name: '/mute', short: 'Setzt einen Discord-Timeout.', details: 'Schaltet einen Nutzer fuer die angegebene Dauer stumm.', requires: 'entsprechende Moderationsberechtigung' },
  { name: '/warn', short: 'Verwarnt einen Nutzer.', details: 'Erzeugt einen Moderations-/Warn-Eintrag.', requires: 'entsprechende Moderationsberechtigung' },
  { name: '/appeal', short: 'Reicht einen Einspruch zu einer Moderationsaktion ein.', details: 'Der Einspruch wird zur Pruefung gespeichert.' },

  // Fraktionen
  { name: '/fraktionen', short: 'Listet Fraktionen des Servers gruppiert nach Gameserver-Slot.', details: 'Zeigt Fraktionen der aktuellen Guild slotuebergreifend.' },
  { name: '/factions', short: 'Listet aktive Fraktionen.', details: 'Zeigt aktive Fraktionen des aktuellen Gameserver-Kontexts.' },
  { name: '/faction', short: 'Zeigt Details zu einer Fraktion.', details: 'Zeigt Leitung, Mitglieder und Status.' },
  { name: '/join', short: 'Tritt einer Fraktion bei oder stellt eine Anfrage.', details: 'Das Verhalten richtet sich nach der Join-Policy der Fraktion.' },
  { name: '/leave', short: 'Verlaesst die aktuelle Fraktion.', details: 'Entfernt die eigene Mitgliedschaft im Fraktionssystem.' },

  // Economy / Identitaets-Link
  { name: '/link', short: 'Startet die sichere Verknuepfung mit der DayZ-Spielidentitaet.', details: 'Erzeugt einen Ingame-Code; die ADM-Erkennung bestaetigt die Spielidentitaet servergescopet.' },
  { name: '/unlink', short: 'Entfernt die eigene Spielidentitaets-Verknuepfung.', details: 'Entfernt die Verknuepfung im aktiven Gameserver-Slot.' },
  { name: '/balance', short: 'Zeigt Wallet, Bank und letzte Transaktionen.', details: 'Economy-Daten sind pro Guild und Gameserver-Slot getrennt.' },
  { name: '/bank', short: 'Zeigt Wallet, Bank und Gesamtguthaben.', details: 'Zeigt die eigene Economy-Uebersicht im aktiven Slot.' },
  { name: '/pay', short: 'Sendet Coins aus der Wallet an einen anderen User.', details: 'Die Zahlung bleibt im selben Gameserver-Scope.' },
  { name: '/deposit', short: 'Verschiebt Coins von Wallet auf Bank.', details: 'Bucht den angegebenen Betrag auf das eigene Bankkonto.' },
  { name: '/withdraw', short: 'Verschiebt Coins von Bank auf Wallet.', details: 'Hebt den angegebenen Betrag vom eigenen Bankkonto ab.' },
  { name: '/transfer', short: 'Ueberweist Coins von Bank zu Bank.', details: 'Ueberweisung an einen anderen User innerhalb desselben Gameserver-Slots.' },

  // Casino
  { name: '/slot', short: 'Spielt die konfigurierte Slot-Maschine.', details: 'Einsatz und Auszahlung laufen ueber das servergescopte Economy-Konto.' },
  { name: '/coinflip', short: 'Spielt Kopf oder Zahl.', details: 'Casino-Spiel mit konfiguriertem Einsatz-/Auszahlungsmodell.' },
  { name: '/dice', short: 'Spielt das Wuerfelspiel.', details: 'Tippe eine Zahl von 1 bis 6 und setze Coins.' },
  { name: '/blackjack', short: 'Spielt vereinfachtes Blackjack.', details: 'Casino-Spiel im aktiven Economy-Slot.' },
  { name: '/casino-stats', short: 'Zeigt Casino-Statistiken.', details: 'Zeigt Runden, Win-Rate, Einsatz, Auszahlung und Netto fuer den aktiven Slot.' },

  // Nitrado Whitelist / Ban
  { name: '/whitelist', short: 'Stellt eine Whitelist-Anfrage fuer einen Spielernamen.', details: 'Bei mehreren Nitrado-Servern wird der Server ueber Alias ausgewaehlt; die Anfrage wird serverspezifisch verarbeitet.' },
  { name: '/wl-add', short: 'Fuegt einen Spielernamen zur Nitrado-Whitelist hinzu.', details: 'Optional fuer einen Alias, sonst fuer alle aktiven verknuepften Gameserver.', requires: 'whitelist.manage bzw. Owner' },
  { name: '/wl-remove', short: 'Entfernt einen Spielernamen von der Nitrado-Whitelist.', details: 'Optional fuer einen Alias, sonst fuer alle aktiven verknuepften Gameserver.', requires: 'whitelist.manage bzw. Owner' },
  { name: '/wl-list', short: 'Liest die echte Nitrado-Whitelist.', details: 'Zeigt die Remote-Whitelist getrennt pro ausgewaehltem/verknuepftem Gameserver.', requires: 'whitelist.manage bzw. Owner' },
  { name: '/server-ban', short: 'Bannt einen Gameserver-Identifier auf Nitrado.', details: 'Optional zeitlich begrenzt. Ein zeitlicher Ban wird nach Ablauf automatisch aus der echten Nitrado-Banliste entfernt und im urspruenglichen Command-Kanal bestaetigt.', requires: 'bans.manage bzw. Owner' },
  { name: '/server-unban', short: 'Entfernt einen Gameserver-Ban.', details: 'Entfernt den lokalen/Remote-Ban im gewaehlten oder allen verknuepften Gameservern.', requires: 'bans.manage bzw. Owner' },
  { name: '/server-ban-list', short: 'Zeigt die Nitrado-Server-Banliste.', details: 'Liest Ban-Informationen pro verknuepftem Gameserver.', requires: 'bans.manage bzw. Owner' },

  // Delegierte Serververwaltung (keine globalen Bot-Admin/DEV-Funktionen)
  { name: '/perm-add', short: 'Vergibt einen delegierbaren Server-Scope.', details: 'Nur der Discord-Server-Owner kann delegierbare Dashboard/Gameserver-Berechtigungen vergeben.', requires: 'Discord-Server-Owner' },
  { name: '/perm-remove', short: 'Entzieht einen delegierbaren Server-Scope.', details: 'Entfernt einen zuvor vergebenen Guild-Scope.', requires: 'Discord-Server-Owner' },
  { name: '/perms', short: 'Listet Permission-Grants der Guild.', details: 'Zeigt die delegierten Server-Scope-Berechtigungen.', requires: 'Discord-Server-Owner' },
];

export function asksAboutCommands(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(command|commands|befehl|befehle|funktion(en)?|feature(s)?)\b/.test(q) ||
    /was\s+(kannst|machst)\s+du\b/.test(q) ||
    /\b(welche|wie viele)\s+(commands?|befehle|funktionen|features)\b/.test(q) ||
    /\b(hilfe|help)\b/.test(q) ||
    /\bwie\s+(funktioniert|nutze|benutze)\s+(ich\s+)?(der\s+|den\s+|die\s+|das\s+)?bot\b/.test(q) ||
    /\/[a-z][a-z-]*/i.test(q)
  );
}

export function findReferencedCommands(question: string): PublicCommandDoc[] {
  const q = question.toLowerCase();
  const matches: PublicCommandDoc[] = [];
  const seen = new Set<string>();
  for (const c of PUBLIC_COMMAND_CATALOG) {
    const needle = c.name.toLowerCase();
    if (q.includes(needle) && !seen.has(c.name)) {
      matches.push(c);
      seen.add(c.name);
    }
  }
  if (matches.length > 0) return matches;

  const baseRegex = /\/([a-z][a-z-]*)/gi;
  const bases = new Set<string>();
  for (const m of q.matchAll(baseRegex)) bases.add(m[1].toLowerCase());
  for (const base of bases) {
    for (const c of PUBLIC_COMMAND_CATALOG) {
      if (seen.has(c.name)) continue;
      if (c.name.toLowerCase().split(/\s+/)[0] === `/${base}`) {
        matches.push(c);
        seen.add(c.name);
      }
    }
  }
  return matches;
}

function formatEntry(c: PublicCommandDoc): string {
  const lines = [`- ${c.name} — ${c.short}`, `  ${c.details}`];
  if (c.requires) lines.push(`  Voraussetzung: ${c.requires}`);
  if (c.limits) lines.push(`  Limits: ${c.limits}`);
  if (c.related?.length) lines.push(`  Verwandt: ${c.related.join(', ')}`);
  if (c.examples?.length) lines.push(`  Beispiel: ${c.examples.join(' | ')}`);
  return lines.join('\n');
}

export function formatCatalogForPrompt(): string {
  const lines = [
    'AKTUELLER DISCORD-COMMAND-KATALOG:',
    'Bot-Admin- und DEV-Verwaltung ist Dashboard-only. Erfinde dafuer keine Slash-Commands. Hersteller-Slash-Funktionen bleiben in Discord.',
    '',
  ];
  for (const c of PUBLIC_COMMAND_CATALOG) lines.push(formatEntry(c));
  lines.push('', 'GLOSSAR:');
  for (const g of GLOSSARY) lines.push(`- ${g.term}: ${g.explanation}`);
  lines.push('', answerRules());
  return lines.join('\n');
}

export function formatCatalogForPromptFocused(question: string): string {
  const matches = findReferencedCommands(question);
  if (matches.length === 0) return formatCatalogForPrompt();
  const lines = ['AKTUELLER COMMAND-KATALOG-AUSZUG:', ''];
  for (const c of matches) lines.push(formatEntry(c));
  lines.push('', answerRules());
  return lines.join('\n');
}

function answerRules(): string {
  return [
    'ANTWORT-REGELN BEI COMMAND-/FUNKTIONSFRAGEN:',
    '- Erklaere nur, was wirklich gefragt wurde.',
    '- Stelle Bot-Admin- oder DEV-Dashboard-Funktionen niemals als Discord-Slash-Commands dar.',
    '- Hersteller-Slash-Funktionen /upload, /mypackages und die interne Herstellerverwaltung sind die bewusst erhaltene Ausnahme.',
    '- Erfinde keine Optionen oder Subcommands.',
    '- Wenn ein genannter Slash-Command nicht in diesem Katalog steht, sage nicht automatisch, dass die Funktion generell nicht existiert. Sage: "Diesen Discord-Command sehe ich im aktuellen Katalog nicht."',
    '- Fuer den vollstaendigen aktuellen Discord-Stand ist /help die Live-Wahrheitsquelle, weil /help direkt aus der geladenen Command-Registry erzeugt wird.',
  ].join('\n');
}
