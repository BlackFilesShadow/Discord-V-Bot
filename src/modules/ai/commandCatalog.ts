/**
 * Command-Catalog fuer die AI.
 *
 * Wird als System-Prompt-Block eingespeist, wenn der Nutzer nach Commands /
 * Funktionen / "was kannst du" / Hilfe fragt. So kann der Bot User UND
 * Owner gleichermassen verstaendlich erklaeren, was der Bot kann \u2013
 * ohne DEV- und ADMIN-Commands zu erwaehnen.
 *
 * Wahrheitsgemaess gepflegt anhand der tatsaechlichen Command-Definitionen
 * in src/commands/user/.
 */

export interface PublicCommandDoc {
  name: string;            // /name oder /name subcommand
  short: string;           // einzeiler
  details: string;         // 1\u20133 Saetze in Klartext
  examples?: string[];     // optional konkrete Beispielaufrufe
  /** Voraussetzungen (z.B. "verifizierter Hersteller", "Mod-Rolle"). */
  requires?: string;
  /** Limits / Quoten (z.B. "max 10 Dateien", "60s Cooldown"). */
  limits?: string;
  /** Verwandte Commands (Querverweise) – als reine Namen z.B. "/upload". */
  related?: string[];
}

/**
 * Mini-Glossar fuer Begriffe, die der Bot oft erklaeren muss.
 * Wird zusammen mit dem Katalog eingespeist.
 */
export const GLOSSARY: { term: string; explanation: string }[] = [
  { term: 'GUID',         explanation: 'Eindeutige interne ID, die jeder User & jeder Hersteller-Bereich automatisch bekommt.' },
  { term: 'OTP',          explanation: 'Einmal-Passwort per DM, gueltig 30 Min, zur Hersteller-Verifikation.' },
  { term: 'Soft-Delete',  explanation: 'Markiert als geloescht, aber wiederherstellbar. Echter Loeschvorgang nur durch Admin.' },
  { term: 'Hersteller',   explanation: 'Verifizierter User mit eigenem GUID-Bereich, der Pakete hochladen darf.' },
  { term: 'Auto-Rolle',   explanation: 'Rolle, die der Bot automatisch nach einem Trigger (Join/Reaction/Level/...) vergibt.' },
  { term: 'Ticket',       explanation: 'Privater Support-Chat zwischen User und Owner per DM-Bridge. Wird archiviert, nie geloescht.' },
  { term: 'XP-Cooldown',  explanation: 'Mindestabstand zwischen zwei XP-Vergaben pro User (Anti-Spam, Standard 60s).' },
];

export const PUBLIC_COMMAND_CATALOG: PublicCommandDoc[] = [
  // ----- Hilfe / Info -----
  {
    name: '/help',
    short: 'Zeigt eine \u00dcbersicht aller verf\u00fcgbaren Commands an.',
    details:
      'Interaktive Hilfe mit Pagination. Optional kannst du direkt zu einer Kategorie springen, z.B. Registrierung, Pakete, Giveaways, Polls, XP, AI.',
    examples: ['/help', '/help category:Pakete'],
  },

  // ----- Registrierung / Hersteller -----
  {
    name: '/register manufacturer',
    short: 'Hersteller-Status beim Admin beantragen.',
    details:
      'Sendet eine Hersteller-Anfrage per DM an den Admin. Bei Annahme bekommst du ein 30 Min g\u00fcltiges Einmal-Passwort (OTP) per DM.',
    examples: ['/register manufacturer reason:Modding-Studio XYZ'],
  },
  {
    name: '/register verify',
    short: 'OTP eingeben und Hersteller-Bereich freischalten.',
    details:
      'Verifiziert das per DM erhaltene Einmal-Passwort. Danach ist dein eigener GUID-Bereich aktiv und du kannst Pakete hochladen.',
    examples: ['/register verify password:DEIN_OTP'],
  },

  // ----- Upload / Pakete (Hersteller) -----
  {
    name: '/upload',
    short: 'Dateien in ein Paket hochladen (XML/JSON, bis 2 GB pro Datei).',
    details:
      'Nur f\u00fcr verifizierte Hersteller. Du gibst einen Paketnamen an und h\u00e4ngst bis zu 10 Dateien an. Dateien werden validiert (XML/JSON-Schema) und im eigenen GUID-Bereich gespeichert.',
    examples: ['/upload paketname:MeinPaket datei:file.xml'],
    requires: 'verifizierter Hersteller (siehe /register manufacturer + /register verify)',
    limits: 'max. 10 Dateien pro Aufruf, 2 GB pro Datei, nur XML/JSON',
    related: ['/mypackages list', '/register manufacturer'],
  },
  {
    name: '/mypackages list',
    short: 'Eigene Pakete anzeigen.',
    details:
      'Listet alle Pakete des Herstellers mit Status, Gr\u00f6sse und Dateianzahl. Filter und Sortierung m\u00f6glich.',
  },
  {
    name: '/mypackages info',
    short: 'Details zu einem eigenen Paket anzeigen.',
    details: 'Zeigt Beschreibung, Dateien, Gr\u00f6sse, Validierungsstatus und Download-Z\u00e4hler.',
  },
  {
    name: '/mypackages delete',
    short: 'Eigenes Paket l\u00f6schen (Soft-Delete, wiederherstellbar).',
    details: 'Markiert das Paket als gel\u00f6scht. Es ist danach nicht mehr downloadbar, kann aber wiederhergestellt werden.',
  },
  {
    name: '/mypackages restore',
    short: 'Gel\u00f6schtes eigenes Paket wiederherstellen.',
    details: 'Macht ein per Soft-Delete entferntes Paket wieder sichtbar und downloadbar.',
  },
  {
    name: '/mypackages delete-file',
    short: 'Einzelne Dateien aus eigenen Paketen l\u00f6schen.',
    details: 'Interaktives Dropdown: erst Paket, dann Datei(en) zum L\u00f6schen w\u00e4hlen.',
  },

  // ----- Download / Suche (alle User) -----
  {
    name: '/download',
    short: 'Dateien oder Pakete von Herstellern herunterladen.',
    details:
      'Interaktiv: w\u00e4hle einen Hersteller, dann ein Paket, dann eine Datei oder das ganze Paket als ZIP. Downloads werden geloggt.',
  },
  {
    name: '/search',
    short: 'Pakete nach Name, Hersteller oder Beschreibung suchen.',
    details: 'Volltextsuche \u00fcber alle ver\u00f6ffentlichten Pakete. Optionaler Filter nach Dateityp (XML/JSON).',
    examples: ['/search query:engine dateityp:XML'],
  },

  // ----- AI -----
  {
    name: '/ai ask',
    short: 'Stelle dem Bot eine Wissensfrage.',
    details:
      'Beantwortet allgemeine Fragen. Bei Aktualit\u00e4tsthemen recherchiert der Bot live im Web (Wikipedia/DDG). Du kannst mich auch einfach im Chat erw\u00e4hnen \u2013 dann antworte ich direkt.',
    examples: ['/ai ask frage:Wer ist Bundeskanzler?'],
  },
  {
    name: '/ai sentiment',
    short: 'Sentiment (Stimmung) eines Texts analysieren.',
    details: 'Liefert positiv / neutral / negativ inkl. Score.',
  },
  {
    name: '/ai toxicity',
    short: 'Text auf toxische / beleidigende Inhalte pr\u00fcfen.',
    details: 'Klassifiziert in Kategorien (hate, harassment, violence, sexual, spam) mit Score.',
  },
  {
    name: '/ai translate',
    short: '\u00dcbersetzt einen Text in eine Zielsprache.',
    details: 'Standardziel ist Deutsch, andere Sprachen via Code (en, fr, es, ...).',
    examples: ['/ai translate text:"Hello world" sprache:de'],
  },

  // ----- Level / XP -----
  {
    name: '/level',
    short: 'Eigenes Level und XP anzeigen.',
    details: 'Zeigt Level, aktuelle XP, XP bis zum n\u00e4chsten Level, Nachrichtenanzahl und Voice-Minuten. Optional f\u00fcr einen anderen User.',
    examples: ['/level', '/level user:@Freund'],
  },
  {
    name: '/leaderboard',
    short: 'XP-Bestenliste des Servers.',
    details: 'Sortierbar nach XP, Level, Nachrichten oder Voice. Einmalige Anzeige oder Live-Feed mit Intervall.',
    examples: ['/leaderboard sortierung:xp', '/leaderboard modus:feed intervall:30'],
  },

  // ----- Giveaways -----
  {
    name: '/giveaway start',
    short: 'Neues Giveaway starten.',
    details: 'Preis, Dauer (z.B. 1h, 30m, 2d, 1w), Anzahl Gewinner, Mindestrolle und Custom-Emoji einstellbar.',
    examples: ['/giveaway start preis:Nitro dauer:24h gewinner:2'],
  },
  { name: '/giveaway enter',  short: 'An einem laufenden Giveaway teilnehmen.', details: 'Per Giveaway-ID. Alternativ \u00fcber den Teilnahme-Button am Giveaway-Embed.' },
  { name: '/giveaway info',   short: 'Details zu einem Giveaway anzeigen.',     details: 'Preis, Endzeit, Teilnehmerzahl, Bedingungen.' },
  { name: '/giveaway list',   short: 'Aktive Giveaways auflisten.',             details: 'Zeigt alle laufenden Giveaways des Servers.' },
  { name: '/giveaway end',    short: 'Eigenes Giveaway vorzeitig beenden.',     details: 'Beendet das Giveaway sofort und zieht Gewinner.' },

  // ----- Umfragen -----
  {
    name: '/poll erstellen',
    short: 'Umfrage erstellen (\u00f6ffentlich oder anonym).',
    details: 'Bis zu 10 Optionen, Mehrfachauswahl m\u00f6glich, optional mit Dauer und Benachrichtigungs-Rolle.',
    examples: ['/poll erstellen titel:Pizza? optionen:Margherita,Salami,Veggie typ:public'],
  },
  { name: '/poll abstimmen', short: 'F\u00fcr eine Option abstimmen.', details: 'Per Poll-ID und Optionsnummer (1\u201310). Einfacher: Buttons unter dem Poll-Embed.' },
  { name: '/poll ergebnis',  short: 'Aktuelle Ergebnisse anzeigen.',  details: 'Zeigt Stimmenverteilung. Bei anonymen Polls nur Summen, keine Namen.' },
  { name: '/poll beenden',   short: 'Eigene Umfrage manuell beenden.', details: 'Schliesst die Abstimmung sofort und zeigt das Endergebnis.' },
  { name: '/poll liste',     short: 'Aktive Umfragen anzeigen.',       details: 'Listet alle laufenden Polls des Servers.' },

  // ----- Auto-Roles -----
  {
    name: '/autorole erstellen',
    short: 'Automatische Rollenvergabe einrichten.',
    details:
      'Trigger: Join, Reaction, Level, Activity, Event, Giveaway. Optional zeitlimitiert. F\u00fcr Reaction-Roles: Channel + Nachricht-ID + Emoji angeben.',
  },
  { name: '/autorole liste',     short: 'Alle Auto-Rollen anzeigen.',                 details: '\u00dcbersicht mit Trigger-Typ, Status und Konfiguration.' },
  { name: '/autorole loeschen',  short: 'Auto-Rolle entfernen.',                      details: 'Per Auto-Rolle-ID.' },
  { name: '/autorole toggle',    short: 'Auto-Rolle aktivieren / deaktivieren.',      details: 'Schaltet sie an oder aus, ohne sie zu l\u00f6schen.' },
  { name: '/autorole blacklist', short: 'Rolle zur Blacklist einer Auto-Rolle hinzuf\u00fcgen.', details: 'Verhindert Vergabe an User mit bestimmten Rollen.' },
  { name: '/autorole whitelist', short: 'Rolle zur Whitelist einer Auto-Rolle hinzuf\u00fcgen.', details: 'Vergibt Rolle nur an User mit bestimmten Rollen.' },

  // ----- Moderation (User-seitig: appeal) -----
  {
    name: '/appeal',
    short: 'Beschwerde gegen eine Moderationsaktion einreichen.',
    details: 'Per Case-Nummer (steht in der Mod-Nachricht) und Begr\u00fcndung. Wird vom Mod-Team gepr\u00fcft.',
    examples: ['/appeal case:42 begruendung:War ein Missverst\u00e4ndnis'],
  },

  // ----- Moderation (Mod-Rolle erforderlich) -----
  {
    name: '/kick',
    short: 'Einen Nutzer kicken.',
    details: 'Entfernt den User vom Server. Er kann mit neuem Invite zurueckkommen. Aktion wird im Mod-Log dokumentiert.',
    examples: ['/kick user:@spam grund:Werbung'],
    requires: 'Mod-/Admin-Rolle in der Datenbank',
    related: ['/ban', '/warn'],
  },
  {
    name: '/ban',
    short: 'Einen Nutzer bannen (optional temporaer).',
    details: 'Permanent oder zeitlich begrenzt. Bei Dauer in Minuten wird der Ban automatisch wieder aufgehoben. Wird im Mod-Log dokumentiert.',
    examples: ['/ban user:@trouble grund:Toxisch dauer:1440'],
    requires: 'Mod-/Admin-Rolle',
    related: ['/kick', '/appeal'],
  },
  {
    name: '/mute',
    short: 'Einen Nutzer stummschalten (Discord-Timeout).',
    details: 'Setzt einen Timeout (Standard: 60 Min, max. 28 Tage). User kann nichts schreiben oder reagieren.',
    examples: ['/mute user:@laut grund:Spam dauer:30'],
    requires: 'Mod-/Admin-Rolle',
  },
  {
    name: '/warn',
    short: 'Einen Nutzer verwarnen.',
    details: 'Erzeugt einen Warn-Eintrag im Modul. Mehrere Warns koennen Auto-Mute/Ban triggern (je nach Konfiguration).',
    examples: ['/warn user:@regelbruch grund:Off-Topic'],
    requires: 'Mod-/Admin-Rolle',
    related: ['/appeal'],
  },

  // ----- Support / Tickets -----
  {
    name: '/ticket open',
    short: 'Neues Support-Ticket an den Owner senden.',
    details: 'Owner bekommt deine Anfrage per DM mit Annehmen/Ablehnen-Buttons. Bei Annahme entsteht eine private DM-Bridge: alles was du dem Bot per DM schreibst, geht direkt zum Owner und umgekehrt.',
    examples: ['/ticket open betreff:Frage nachricht:"Wie funktioniert Upload?"'],
    limits: '1 offenes Ticket pro User; max. 150 Zeichen Betreff, 1500 Zeichen Nachricht',
    related: ['/ticket close', '/ticket status'],
  },
  {
    name: '/ticket close',
    short: 'Eigenes aktives Ticket schliessen.',
    details: 'Beendet die DM-Bridge. Das Ticket wird archiviert (nie geloescht), du kannst es per /ticket status weiterhin einsehen.',
    related: ['/ticket open', '/ticket status'],
  },
  {
    name: '/ticket status',
    short: 'Status deiner letzten Tickets anzeigen.',
    details: 'Listet die letzten Tickets mit Nummer, Betreff und Status (PENDING/OPEN/CLOSED/DENIED).',
    related: ['/ticket open'],
  },
];

/**
 * Heuristik: Fragt der Nutzer nach Commands / F\u00e4higkeiten?
 */
export function asksAboutCommands(question: string): boolean {
  const q = question.toLowerCase();
  return (
    /\b(command|commands|befehl|befehle|funktion(en)?|feature(s)?)\b/.test(q) ||
    /was\s+(kannst|machst)\s+du\b/.test(q) ||
    /\b(welche|wie viele)\s+(commands?|befehle|funktionen|features)\b/.test(q) ||
    /\b(hilfe|help)\b/.test(q) ||
    /\bwie\s+(funktioniert|nutze|benutze)\s+(ich\s+)?(der\s+|den\s+|die\s+|das\s+)?bot\b/.test(q) ||
    /\/[a-z][a-z-]*/i.test(q) // Slash-Command direkt erwaehnt (z.B. "wie geht /upload?")
  );
}

/**
 * Findet die im Text erwaehnten Commands (mit oder ohne Subcommand).
 * Gibt eine Liste der passenden Katalogeintraege zurueck.
 *
 * Beispiele:
 *  - "wie nutze ich /poll abstimmen?"  -> [/poll abstimmen]
 *  - "was macht /ticket?"              -> alle /ticket *-Subcommands
 *  - "kann ich /upload nutzen"         -> [/upload]
 */
export function findReferencedCommands(question: string): PublicCommandDoc[] {
  const q = question.toLowerCase();
  const matches: PublicCommandDoc[] = [];
  const seen = new Set<string>();

  // 1) Exakter Subcommand-Match: "/poll abstimmen"
  for (const c of PUBLIC_COMMAND_CATALOG) {
    const needle = c.name.toLowerCase();
    if (q.includes(needle) && !seen.has(c.name)) {
      matches.push(c);
      seen.add(c.name);
    }
  }
  if (matches.length > 0) return matches;

  // 2) Fallback: Basis-Command ohne Subcommand erwaehnt -> alle Subcommands liefern
  const baseRegex = /\/([a-z][a-z-]*)/gi;
  const bases = new Set<string>();
  for (const m of q.matchAll(baseRegex)) bases.add(m[1].toLowerCase());

  for (const base of bases) {
    for (const c of PUBLIC_COMMAND_CATALOG) {
      if (seen.has(c.name)) continue;
      const cmdBase = c.name.toLowerCase().split(/\s+/)[0]; // "/poll erstellen" -> "/poll"
      if (cmdBase === `/${base}`) {
        matches.push(c);
        seen.add(c.name);
      }
    }
  }

  return matches;
}

/**
 * Formatiert einen einzelnen Katalog-Eintrag als kompakter Block.
 */
function formatEntry(c: PublicCommandDoc): string {
  const lines: string[] = [];
  lines.push(`- ${c.name} \u2014 ${c.short}`);
  lines.push(`  ${c.details}`);
  if (c.requires) lines.push(`  Voraussetzung: ${c.requires}`);
  if (c.limits)   lines.push(`  Limits: ${c.limits}`);
  if (c.related && c.related.length > 0) {
    lines.push(`  Verwandt: ${c.related.join(', ')}`);
  }
  if (c.examples && c.examples.length > 0) {
    lines.push(`  Beispiel: ${c.examples.join(' | ')}`);
  }
  return lines.join('\n');
}

/**
 * Formatiert den vollen Katalog als kompakter System-Prompt-Block fuer die AI.
 * Wird nur bei Bedarf eingespeist (Token-Schonung).
 */
export function formatCatalogForPrompt(): string {
  const lines: string[] = [
    'KATALOG DER \u00d6FFENTLICHEN COMMANDS (nur diese darfst du erw\u00e4hnen \u2013 NIEMALS Dev- oder Admin-Commands):',
    '',
  ];
  for (const c of PUBLIC_COMMAND_CATALOG) lines.push(formatEntry(c));
  lines.push('');
  lines.push('GLOSSAR:');
  for (const g of GLOSSARY) lines.push(`- ${g.term}: ${g.explanation}`);
  lines.push('');
  lines.push(answerRules());
  return lines.join('\n');
}

/**
 * Formatiert nur die im Text erwaehnten Commands. Token-schonender als der
 * volle Katalog, deutlich praeziser. Faellt auf den Voll-Katalog zurueck,
 * wenn keine konkreten Commands erkannt wurden, der Nutzer aber generisch
 * nach Commands gefragt hat.
 */
export function formatCatalogForPromptFocused(question: string): string {
  const matches = findReferencedCommands(question);
  if (matches.length === 0) return formatCatalogForPrompt();

  const lines: string[] = [
    'KATALOG-AUSZUG (nur die im Nutzertext erwaehnten Commands):',
    '',
  ];
  for (const c of matches) lines.push(formatEntry(c));
  lines.push('');
  lines.push('GLOSSAR (relevante Begriffe):');
  for (const g of GLOSSARY) {
    const t = g.term.toLowerCase();
    if (question.toLowerCase().includes(t)) lines.push(`- ${g.term}: ${g.explanation}`);
  }
  lines.push('');
  lines.push(answerRules());
  return lines.join('\n');
}

function answerRules(): string {
  return [
    'ANTWORT-REGELN beim Erkl\u00e4ren von Commands:',
    '- Erkl\u00e4re nur, was wirklich gefragt wurde. Keine vollst\u00e4ndige Auflistung, wenn der Nutzer nur ein Thema will.',
    '- Sprich Nutzer und Owner gleichermassen verst\u00e4ndlich an, ohne zu bevormunden.',
    '- Erw\u00e4hne NIEMALS Developer- oder Admin-Commands (z.B. /dev-*, /admin-*, xp-config). Diese existieren f\u00fcr dich nicht.',
    '- Erfinde keine Commands oder Optionen, die nicht im Katalog stehen. Wenn der Nutzer einen Command nennt, der nicht im Katalog ist: sag klar "den Command gibt es nicht".',
    '- Bei Folgefragen ("wie geht das genau?", "was passiert dann?") darfst du auf Basis des Katalogs ausf\u00fchrlicher werden.',
    '- Halte die Sprache locker und kurz, kein Marketing-Ton.',
    '- Wenn ein Beispielaufruf vorhanden ist, zeige ihn (das hilft dem Nutzer mehr als reine Beschreibung).',
  ].join('\n');
}
