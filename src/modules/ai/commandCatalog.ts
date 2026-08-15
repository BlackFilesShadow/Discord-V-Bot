import { config } from '../../config';

/**
 * Oeffentlicher Command-Katalog fuer AI-Antworten ueber Discord-Funktionen.
 * DEV/Bot-Admin sowie /ai selbst sind bewusst NICHT enthalten. Damit kann die
 * AI diese Bereiche bei Command-/Funktionsfragen nicht als sichtbare
 * Slash-Commands empfehlen.
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
  { term: 'Hersteller', explanation: 'Verifizierter ACTIVE-User mit Herstellerflag und MANUFACTURER-Rolle.' },
  { term: 'Gameserver-Slot', explanation: 'Ein mit der Discord-Guild verknuepfter Nitrado-DayZ-Server. Serveraktionen bleiben pro Slot getrennt.' },
  { term: 'XP-Cooldown', explanation: 'Mindestabstand zwischen XP-Vergaben als Anti-Spam-Schutz.' },
];

export const PUBLIC_COMMAND_CATALOG: PublicCommandDoc[] = [
  { name: '/help', short: 'Zeigt die freigegebenen Discord-Commands.', details: 'Die Hilfe wird aus der Live-Registry erzeugt. DEV und /ai bleiben dort vollstaendig unsichtbar.' },
  { name: '/stell-dich-vor', short: 'Stellt V-Bot Prime und den aktuellen Funktionsumfang vor.', details: 'Verwendet dieselbe kanonische Bot-Info-Quelle wie der Mention-Responder.' },

  // Hersteller
  { name: '/register manufacturer', short: 'Beantragt Hersteller-Status.', details: 'Erstellt eine Hersteller-Anfrage; nach Freigabe folgt OTP-Verifikation.', related: ['/register verify', '/upload'] },
  { name: '/register verify', short: 'Schliesst Hersteller-Verifikation mit OTP ab.', details: 'Aktiviert den Herstellerzugang atomar nach erfolgreichem OTP-Verbrauch.' },
  { name: '/upload', short: `Laedt XML/JSON-Dateien in ein Hersteller-Paket hoch (max. ${uploadMiB} MiB je Datei).`, details: 'Nur ACTIVE + isManufacturer + role=MANUFACTURER; Upload und Paketstatistik werden atomar verarbeitet.', requires: 'verifizierter Hersteller', limits: `max. 10 Dateien pro Aufruf; erlaubte Endungen: ${config.upload.allowedExtensions.join(', ')}` },
  { name: '/mypackages list', short: 'Listet eigene Pakete.', details: 'Vollstaendig paginiert.', requires: 'verifizierter Hersteller' },
  { name: '/mypackages info', short: 'Zeigt Details zu einem eigenen Paket.', details: 'Zeigt Paket- und Dateiinformationen.', requires: 'verifizierter Hersteller' },
  { name: '/mypackages delete', short: 'Loescht ein eigenes Paket per Soft-Delete.', details: 'Paket kann spaeter wiederhergestellt werden.', requires: 'verifizierter Hersteller' },
  { name: '/mypackages restore', short: 'Stellt ein Soft-Deleted Paket wieder her.', details: 'Bewusst einzeln geloeschte Dateien werden dabei nicht wiederbelebt.', requires: 'verifizierter Hersteller' },
  { name: '/mypackages delete-file', short: 'Entfernt eine Datei aus einem eigenen Paket.', details: 'Dateiloeschung und Paketstatistik werden atomar aktualisiert.', requires: 'verifizierter Hersteller' },
  { name: '/search', short: 'Sucht veroeffentlichte Pakete.', details: 'Sucht freigegebene Paketdaten.' },
  { name: '/download', short: 'Laedt freigegebene Hersteller-Dateien/Pakete herunter.', details: 'Nur aktive Hersteller und VALID gepruefte Dateien koennen ausgeliefert werden.' },

  // Community / Reminder / XP
  { name: '/feedback', short: 'Sendet Feedback.', details: 'Oeffnet ein Modal fuer Bug-Reports, Ideen, Lob oder sonstiges Feedback.', limits: '30 Sekunden Cooldown' },
  { name: '/erinnerung setzen', short: 'Legt eine persoenliche Erinnerung an.', details: 'Zustellung per Kanal mit DM-Fallback; fehlgeschlagene Zustellung wird retry-sicher erneut versucht.', limits: 'max. 25 aktive Reminder; wiederkehrend mindestens 1 Minute', related: ['/erinnerung liste', '/erinnerung loeschen'] },
  { name: '/erinnerung liste', short: 'Zeigt eigene aktive Erinnerungen.', details: 'Listet persoenliche Reminder.' },
  { name: '/erinnerung loeschen', short: 'Loescht eine eigene Erinnerung.', details: 'Verwendet die Reminder-ID aus der Liste.' },
  { name: '/level', short: 'Zeigt Level und XP.', details: 'Zeigt den eigenen oder optional einen anderen Levelstand.' },
  { name: '/leaderboard', short: 'Zeigt die Guild-XP-Bestenliste.', details: 'Bleibt fuer normale User oeffentlich.' },
  { name: '/giveaway', short: 'Verwaltet Giveaways.', details: 'Start, Teilnahme, Info, Liste und Ende; Rollenregeln gelten fuer Slash- und Button-Teilnahme identisch.' },
  { name: '/poll', short: 'Verwaltet Umfragen.', details: 'Erstellen, abstimmen, Ergebnisse, Liste und Ende. Votes und Finalisierung sind pro Poll serialisiert.' },
  { name: '/ticket open', short: 'Oeffnet ein Support-Ticket.', details: 'Erstellt eine private Support-Anfrage.', related: ['/ticket close', '/ticket status'] },
  { name: '/ticket close', short: 'Schliesst das eigene aktive Ticket.', details: 'Beendet den aktiven Support-Flow.' },
  { name: '/ticket status', short: 'Zeigt Status eigener Tickets.', details: 'Listet die letzten Support-Tickets.' },

  // Moderation
  { name: '/kick', short: 'Kickt einen Discord-Nutzer.', details: 'Fehlgeschlagene Kicks hinterlassen keinen aktiven Fake-Case.', requires: 'Moderationsberechtigung' },
  { name: '/ban', short: 'Bannt einen Discord-Nutzer.', details: 'Discord-Moderationsban; getrennt von Nitrado-Server-Bans.', requires: 'Moderationsberechtigung' },
  { name: '/mute', short: 'Setzt einen Discord-Timeout.', details: 'Fehlgeschlagene Timeouts hinterlassen keinen aktiven Fake-Case.', requires: 'Moderationsberechtigung' },
  { name: '/warn', short: 'Verwarnt einen Nutzer.', details: 'Erzeugt einen guildgescopten Moderationseintrag.', requires: 'Moderationsberechtigung' },
  { name: '/appeal', short: 'Reicht Einspruch zu einer Moderationsaktion ein.', details: 'Nur sinnvoll aktive Sanktionen koennen appealed werden.' },

  // Fraktionen — bewusst Guild-weit, nicht Nitrado-Slot-gebunden
  { name: '/fraktionen', short: 'Listet Fraktionen der Discord-Guild.', details: 'Fraktionen sind bewusst Guild-weit und nicht an einen Nitrado-Slot gebunden.' },
  { name: '/factions', short: 'Listet aktive Fraktionen.', details: 'Zeigt Guild-weite Fraktionen.' },
  { name: '/faction', short: 'Zeigt Fraktionsdetails.', details: 'Zeigt Leitung, Mitglieder und Status.' },
  { name: '/join', short: 'Tritt einer Fraktion bei oder stellt eine Anfrage.', details: 'Parallele Join-Versuche sind serialisiert; OPEN-Join synchronisiert die Discord-Rolle.' },
  { name: '/leave', short: 'Verlaesst die aktuelle Fraktion.', details: 'Entfernt Mitgliedschaft und Discord-Fraktionsrolle.' },

  // Economy / Linking
  { name: '/link', short: 'Verknuepft die DayZ-Spielidentitaet.', details: 'Bei mehreren Gameservern wird ein Slot ausgewaehlt.' },
  { name: '/unlink', short: 'Entfernt die eigene DayZ-Verknuepfung.', details: 'Servergescopet.' },
  { name: '/balance', short: 'Zeigt Wallet, Bank und Transaktionen.', details: 'Economy-Daten sind Guild- und Gameserver-Slot-getrennt.' },
  { name: '/bank', short: 'Zeigt Wallet, Bank und Gesamtguthaben.', details: 'Aktiver Gameserver-Slot.' },
  { name: '/pay', short: 'Sendet Coins aus der Wallet.', details: 'Bleibt im selben Gameserver-Scope.' },
  { name: '/deposit', short: 'Verschiebt Wallet-Coins auf die Bank.', details: 'Servergescopet.' },
  { name: '/withdraw', short: 'Verschiebt Bank-Coins in die Wallet.', details: 'Servergescopet.' },
  { name: '/transfer', short: 'Ueberweist Bank-Coins.', details: 'Bank-zu-Bank innerhalb desselben Gameserver-Slots.' },

  // Casino
  { name: '/slot', short: 'Spielt die Slot-Maschine.', details: 'winChancePct gilt nur fuer Slot.' },
  { name: '/coinflip', short: 'Spielt Kopf oder Zahl.', details: 'Echtes 50/50.' },
  { name: '/dice', short: 'Tippt eine Zahl von 1 bis 6.', details: 'Echte Trefferchance 1/6.' },
  { name: '/blackjack', short: 'Spielt Blackjack.', details: 'Ace wird korrekt als 11/1 behandelt; Draw erstattet den Einsatz.' },
  { name: '/casino-stats', short: 'Zeigt Casino-Statistik.', details: 'Win/Draw/Loss und Runden-Audit fuer den aktiven Slot.' },

  // Nitrado Whitelist / Ban — kanonische Namen
  { name: '/whitelist-antrag', short: 'Stellt eine Whitelist-Anfrage.', details: 'Bei mehreren Servern muss der Ziel-Alias eindeutig ausgewaehlt werden.' },
  { name: '/whitelist-add', short: 'Fuegt einen Spielernamen zur Whitelist hinzu.', details: 'Optional Alias, sonst alle aktiven verknuepften Gameserver.', requires: 'whitelist.manage bzw. Owner' },
  { name: '/whitelist-remove', short: 'Entfernt einen Spielernamen von der Whitelist.', details: 'Lokale Finalisierung erst nach bestaetigter Nitrado-Entfernung; PENDING_REMOVE verhindert Re-Add.', requires: 'whitelist.manage bzw. Owner' },
  { name: '/whitelist', short: 'Liest die echte Nitrado-Whitelist.', details: 'Remote-Liste getrennt pro Server.', requires: 'whitelist.manage bzw. Owner' },
  { name: '/server-ban', short: 'Bannt einen Gameserver-Identifier.', details: 'Whitelist/Ban-Reihenfolge und Teilfehler bleiben pro Server getrennt.', requires: 'bans.manage bzw. Owner' },
  { name: '/server-unban', short: 'Entfernt einen Gameserver-Ban.', details: 'Liest vor der lokalen Bewertung den echten Nitrado-Zustand.', requires: 'bans.manage bzw. Owner' },
  { name: '/server-ban-list', short: 'Zeigt Nitrado-Server-Bans.', details: 'Pro verknuepftem Gameserver.', requires: 'bans.manage bzw. Owner' },

  // Delegierte Guild-Permissions
  { name: '/perm-add', short: 'Vergibt einen delegierbaren Server-Scope.', details: 'Lost-Update-sicher.', requires: 'Discord-Server-Owner' },
  { name: '/perm-remove', short: 'Entzieht einen delegierbaren Server-Scope.', details: 'Lost-Update-sicher.', requires: 'Discord-Server-Owner' },
  { name: '/perms', short: 'Listet Permission-Grants der Guild.', details: 'Vollstaendige, nicht still abgeschnittene Liste.', requires: 'Discord-Server-Owner' },
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
  for (const command of PUBLIC_COMMAND_CATALOG) {
    const needle = command.name.toLowerCase();
    if (q.includes(needle) && !seen.has(command.name)) {
      matches.push(command);
      seen.add(command.name);
    }
  }
  if (matches.length > 0) return matches;

  const baseRegex = /\/([a-z][a-z-]*)/gi;
  const bases = new Set<string>();
  for (const match of q.matchAll(baseRegex)) bases.add(match[1].toLowerCase());
  for (const base of bases) {
    for (const command of PUBLIC_COMMAND_CATALOG) {
      if (seen.has(command.name)) continue;
      if (command.name.toLowerCase().split(/\s+/)[0] === `/${base}`) {
        matches.push(command);
        seen.add(command.name);
      }
    }
  }
  return matches;
}

function formatEntry(command: PublicCommandDoc): string {
  const lines = [`- ${command.name} — ${command.short}`, `  ${command.details}`];
  if (command.requires) lines.push(`  Voraussetzung: ${command.requires}`);
  if (command.limits) lines.push(`  Limits: ${command.limits}`);
  if (command.related?.length) lines.push(`  Verwandt: ${command.related.join(', ')}`);
  if (command.examples?.length) lines.push(`  Beispiel: ${command.examples.join(' | ')}`);
  return lines.join('\n');
}

export function formatCatalogForPrompt(): string {
  const lines = [
    'AKTUELLER OEFFENTLICHER DISCORD-COMMAND-KATALOG:',
    'DEV, Bot-Admin und /ai sind in diesem oeffentlichen Command-Katalog bewusst unsichtbar. Erfinde oder empfehle sie bei Command-Fragen nicht.',
    '',
  ];
  for (const command of PUBLIC_COMMAND_CATALOG) lines.push(formatEntry(command));
  lines.push('', 'GLOSSAR:');
  for (const glossary of GLOSSARY) lines.push(`- ${glossary.term}: ${glossary.explanation}`);
  lines.push('', answerRules());
  return lines.join('\n');
}

export function formatCatalogForPromptFocused(question: string): string {
  const matches = findReferencedCommands(question);
  if (matches.length === 0) return formatCatalogForPrompt();
  const lines = ['AKTUELLER OEFFENTLICHER COMMAND-KATALOG-AUSZUG:', ''];
  for (const command of matches) lines.push(formatEntry(command));
  lines.push('', answerRules());
  return lines.join('\n');
}

function answerRules(): string {
  return [
    'ANTWORT-REGELN BEI COMMAND-/FUNKTIONSFRAGEN:',
    '- Erklaere nur, was wirklich gefragt wurde.',
    '- Stelle DEV-, Bot-Admin- oder /ai-Funktionen nicht als sichtbare Discord-Commands dar.',
    '- Hersteller-Slash-Funktionen bleiben die bewusst erhaltene privilegierte Ausnahme.',
    '- Erfinde keine Optionen oder Subcommands.',
    '- Wenn ein genannter Slash-Command nicht im Katalog steht, sage: "Diesen Discord-Command sehe ich im aktuellen oeffentlichen Katalog nicht."',
    '- /help ist die Live-Wahrheitsquelle der sichtbaren Discord-Commands.',
  ].join('\n');
}
