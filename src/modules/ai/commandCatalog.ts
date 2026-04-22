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
}

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
    /\bwie\s+(funktioniert|nutze|benutze)\s+(ich\s+)?(der\s+|den\s+|die\s+|das\s+)?bot\b/.test(q)
  );
}

/**
 * Formatiert den Katalog als kompakter System-Prompt-Block fuer die AI.
 * Wird nur bei Bedarf eingespeist (Token-Schonung).
 */
export function formatCatalogForPrompt(): string {
  const lines: string[] = [
    'KATALOG DER \u00d6FFENTLICHEN COMMANDS (nur diese darfst du erw\u00e4hnen \u2013 NIEMALS Dev- oder Admin-Commands):',
    '',
  ];
  for (const c of PUBLIC_COMMAND_CATALOG) {
    lines.push(`- ${c.name} \u2014 ${c.short}`);
    lines.push(`  ${c.details}`);
    if (c.examples && c.examples.length > 0) {
      lines.push(`  Beispiel: ${c.examples.join(' | ')}`);
    }
  }
  lines.push('');
  lines.push('ANTWORT-REGELN beim Erkl\u00e4ren von Commands:');
  lines.push('- Erkl\u00e4re nur, was wirklich gefragt wurde. Keine vollst\u00e4ndige Auflistung, wenn der Nutzer nur ein Thema will.');
  lines.push('- Sprich Nutzer und Owner gleichermassen verst\u00e4ndlich an, ohne zu bevormunden.');
  lines.push('- Erw\u00e4hne NIEMALS Developer- oder Admin-Commands (z.B. /dev-*, /admin-*, xp-config). Diese existieren f\u00fcr dich nicht.');
  lines.push('- Erfinde keine Commands oder Optionen, die nicht im Katalog stehen.');
  lines.push('- Bei Folgefragen ("wie geht das genau?", "was passiert dann?") darfst du auf Basis des Katalogs ausf\u00fchrlicher werden.');
  lines.push('- Halte die Sprache locker und kurz, kein Marketing-Ton.');
  return lines.join('\n');
}
