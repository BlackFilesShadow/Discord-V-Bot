/**
 * Generische Nitrado/DayZ-Hilfe für die AI-Schicht.
 *
 * NICHT server-spezifisch. Liefert ausschließlich allgemeine Erklärungen,
 * wie man im Nitrado-Webinterface oder in den Konfig-Dateien etwas findet
 * und einstellt. Es werden NIEMALS Werte des realen Servers ausgespielt
 * (kein Hostname, keine IP, keine Slot-Zahl, keine Mod-Liste).
 *
 * Zielgruppe: Neueinsteiger, die noch nicht wissen wie Nitrado funktioniert.
 */

export interface HelpTopic {
  /** Eindeutiger Slug, z. B. "tag-nacht-zyklus". */
  id: string;
  /** Kurzer, sprechender Titel — wird im System-Prompt sichtbar. */
  title: string;
  /** Wortliste / Phrasen, deren Vorkommen das Topic auslöst (lowercase Substrings). */
  triggers: string[];
  /** Erklärungs-Text in Markdown. Generisch, anbieter-neutral wo möglich. */
  body: string;
}

export interface HelpAnswer {
  /** Fertiger System-Prompt-Block. Leer wenn kein Topic matched. */
  text: string;
  /** Liste der getroffenen Topic-IDs (für Logging). */
  topicIds: string[];
  found: boolean;
}

const EMPTY: HelpAnswer = { text: '', topicIds: [], found: false };

/**
 * Wissensbasis. Bewusst handgeschrieben und kompakt — die LLM bekommt
 * Strukturwissen, nicht den ganzen Wiki-Text.
 */
const TOPICS: HelpTopic[] = [
  {
    id: 'tag-nacht-zyklus',
    title: 'Tag/Nacht-Zyklus in DayZ',
    triggers: [
      'tag', 'nacht', 'tageszeit', 'nachtzeit', 'time accel',
      'timeacceleration', 'tagzeit', 'tag/nacht', 'tag-nacht', 'tag nacht',
      'serverdaytime', 'nightaccel', 'tagesablauf',
    ],
    body: [
      'Der Tag/Nacht-Zyklus wird in der Datei `serverDZ.cfg` über zwei Werte gesteuert:',
      '- `serverTimeAcceleration` — Multiplikator für den Tag (1 = Echtzeit, 24 = ein voller Tag in 1 Stunde).',
      '- `serverNightTimeAcceleration` — zusätzlicher Multiplikator NUR für die Nacht (z. B. 8 macht die Nacht 8× schneller als der Tag-Faktor).',
      'Optional: `serverTime="SystemTime"` oder ein fester Startwert wie `"2024/06/01/12/00"`. `serverTimePersistent = 1` lässt die Server-Uhr Restarts überleben.',
      '',
      'Wo bearbeiten (Nitrado):',
      '1. Webinterface → dein Server → linke Seitenleiste **Einstellungen → General** (oder **Allgemein**). Dort gibt es Felder für die beiden Acceleration-Werte.',
      '2. Alternativ: **Tools → Dateibrowser** öffnen, `serverDZ.cfg` herunterladen, mit Texteditor anpassen, hochladen.',
      '3. **Server-Neustart** durchführen, sonst greift die Änderung nicht.',
    ].join('\n'),
  },
  {
    id: 'slots-maxplayers',
    title: 'Slots / max. Spielerzahl',
    triggers: [
      'slots', 'spielerzahl', 'maxplayer', 'max player', 'max players',
      'spieleranzahl', 'plätze', 'plaetze', 'queue', 'queueSize',
    ],
    body: [
      'Die maximale Spielerzahl wird in `serverDZ.cfg` über `maxPlayers` gesetzt. `queueSize` definiert zusätzlich die Größe der Warteschlange.',
      'Wichtig: das **gemietete Slot-Paket bei Nitrado** ist die harte Obergrenze. `maxPlayers` darüber zu setzen funktioniert nicht — du musst zuerst dein Slot-Paket im Kundenkonto hochstufen.',
      '',
      'Wo bearbeiten:',
      '1. Webinterface → **Einstellungen → General** → Feld "Max Players".',
      '2. Slot-Upgrade: **Mein Server → Slots erweitern** (oder im Nitrado-Kundenkonto).',
      '3. Neustart nötig.',
    ].join('\n'),
  },
  {
    id: 'mods-installieren',
    title: 'Mods installieren / verwalten',
    triggers: [
      'mod', 'mods', 'workshop', 'modliste', 'mod-liste', 'mod liste',
      'cf mod', 'community framework', 'mod installieren', 'addon',
    ],
    body: [
      'DayZ-Mods kommen vom Steam Workshop und werden auf dem Server in das Stammverzeichnis (z. B. `@CF`, `@CommunityOnlineTools`) abgelegt.',
      'Aktivierte Mods müssen im Startparameter mit `-mod=@Mod1;@Mod2` geladen werden. Server-only-Mods (z. B. Admintools) zusätzlich mit `-serverMod=@AdminTools`.',
      '',
      'Wo bearbeiten (Nitrado):',
      '1. **Einstellungen → Allgemein → Mods**. Dort gibt es ein Feld "Mods" / "Workshop Mods" — Mod-IDs oder Mod-Ordner-Namen kommagetrennt eintragen.',
      '2. **Tools → Mod Manager** (sofern verfügbar) lädt Mods vom Workshop direkt in den Server.',
      '3. Bei manuellen Mods: per **Dateibrowser** den `@Mod`-Ordner ins Server-Root hochladen.',
      '4. Wenn die Mod eigene `types.xml` / `cfgspawnabletypes.xml` mitbringt: Inhalte mit den bestehenden Server-Dateien zusammenführen.',
      '5. Neustart.',
    ].join('\n'),
  },
  {
    id: 'serverdz-cfg',
    title: 'serverDZ.cfg — Aufbau und Editieren',
    triggers: [
      'serverdz', 'serverdz.cfg', 'server dz', 'cfg', 'config datei',
      'config file', 'haupt-config', 'hauptkonfig', 'serverconfig',
    ],
    body: [
      '`serverDZ.cfg` ist die Haupt-Konfigurationsdatei eines DayZ-Servers. Sie liegt im Server-Root.',
      'Wichtige Bereiche:',
      '- Identität: `hostname`, `password`, `passwordAdmin` (nicht weitergeben!).',
      '- Verbindungslimits: `maxPlayers`, `queueSize`, `slowConnectionsLimit`.',
      '- Spielzeit: `serverTimeAcceleration`, `serverNightTimeAcceleration`, `serverTimePersistent`, `serverTime`.',
      '- Spielregeln: `disable3rdPerson`, `disableVoN`, `enableMouseAndKeyboard`, `disablePersonalLight`, `lightingConfig`.',
      '- Mission: `class Missions { class DayZ { template = "dayzOffline.chernarusplus"; }; };` — `template` bestimmt die geladene Mission.',
      '',
      'Bearbeiten (Nitrado):',
      '1. **Einstellungen → General/Erweitert** für die meisten Felder per Formular.',
      '2. Für Sonderfälle: **Tools → Dateibrowser → serverDZ.cfg** direkt editieren.',
      '3. Syntax: `key = value;` (Strings in `"…"`, Zahlen ohne Anführungszeichen, Blöcke in `class … { … };`).',
      '4. Nach dem Speichern: Server-Neustart.',
    ].join('\n'),
  },
  {
    id: 'types-xml',
    title: 'types.xml — Loot-Mengen anpassen',
    triggers: [
      'types.xml', 'typesxml', 'nominal', 'lootmenge', 'loot menge',
      'item menge', 'spawnmenge', 'cfgeconomy', 'central economy',
    ],
    body: [
      '`types.xml` definiert für jeden Item-Typ wie viele auf der Karte existieren dürfen, wie lange sie liegen und unter welchen Bedingungen sie spawnen.',
      'Wichtige Felder pro `<type>`:',
      '- `nominal` — Zielmenge, die das Central-Economy-System anstrebt.',
      '- `min` — Untergrenze, ab der nachgespawnt wird.',
      '- `lifetime` — Sekunden, bis das Item ohne Interaktion despawnt.',
      '- `restock` — Sekunden, bevor neue Items in die Spawn-Queue dürfen.',
      '- `<flags …/>` — wo gespawnt werden darf (z. B. `count_in_map`, `crafted`).',
      '- `<usage>`, `<value>`, `<tag>` — Spawn-Kategorien (Military, Town, Tier1…).',
      '',
      'Bearbeiten (Nitrado):',
      '1. **Tools → Dateibrowser** → Pfad endet auf `mpmissions/<deine_mission>/db/types.xml`.',
      '2. Datei herunterladen, mit Texteditor (oder Tools wie *DayZ Editor Loader*, *DayZ Types Editor*) anpassen.',
      '3. Hochladen und **Mission-Wipe ist nicht** nötig — Änderungen greifen nach Server-Neustart.',
      '4. XML-Syntax sauber halten, sonst startet die Mission nicht.',
    ].join('\n'),
  },
  {
    id: 'events-xml',
    title: 'events.xml — dynamische Events / Fahrzeug-Spawns',
    triggers: [
      'events.xml', 'eventsxml', 'event spawn', 'fahrzeug spawn',
      'vehicle spawn', 'helicrash', 'infected event', 'dynamische events',
    ],
    body: [
      '`events.xml` steuert dynamische Vorkommnisse: Fahrzeug-Spawns, Heli-Crash-Sites, dynamische Infected-Events, Animal-Herden.',
      'Wichtige Felder pro `<event>`:',
      '- `nominal` / `min` / `max` — wie viele gleichzeitig.',
      '- `lifetime`, `restock` — Despawn- und Nachschub-Timing.',
      '- `<children>` — welche konkreten Items/Klassen das Event enthält (z. B. welche Fahrzeug-Typen).',
      '- `<position>` — Spawn-Logik: `fixed`/`player`.',
      '',
      'Bearbeiten:',
      '1. **Dateibrowser** → `mpmissions/<mission>/db/events.xml`.',
      '2. Spawn-Punkte für ortsfeste Events liegen in `cfgeventspawns.xml` (gleicher Ordner).',
      '3. Server-Neustart.',
    ].join('\n'),
  },
  {
    id: 'init-c',
    title: 'init.c — Mission-Logik & Spawn-Loadouts',
    triggers: [
      'init.c', 'initc', 'init script', 'mission init', 'spawn loadout',
      'startausrüstung', 'startausruestung', 'fresh spawn',
    ],
    body: [
      '`init.c` ist die Skript-Datei der Mission. Hier wird Vanilla-Logik überschrieben — z. B. das Loadout für frisch gespawnte Spieler oder das Setzen der Server-Wetter-/Zeit-Settings beim Start.',
      'Häufige Anpassungen:',
      '- `void main()` setzt globale Server-Werte (Zeit, Datum, Wetter).',
      '- `class CustomMission … override void StartingEquipSetup()` — Startinventar.',
      '- Aufrufe an Mod-APIs (z. B. ExpansionMod, CF) werden hier registriert.',
      '',
      'Bearbeiten:',
      '1. **Dateibrowser** → `mpmissions/<mission>/init.c`.',
      '2. Vorher Backup ziehen — Syntaxfehler verhindern den Server-Start.',
      '3. Server-Neustart, anschließend in den Logs (`script.log`) nach Compile-Fehlern schauen.',
    ].join('\n'),
  },
  {
    id: 'mission-wechseln',
    title: 'Mission / Karte wechseln',
    triggers: [
      'mission wechseln', 'karte wechseln', 'map wechseln', 'map ändern',
      'map aendern', 'mission ändern', 'mission aendern', 'andere karte',
      'livonia', 'chernarus', 'namalsk', 'sakhal', 'esseker',
    ],
    body: [
      'Die geladene Mission wird in `serverDZ.cfg` über den Block:',
      '```',
      'class Missions {',
      '  class DayZ {',
      '    template = "dayzOffline.chernarusplus";',
      '  };',
      '};',
      '```',
      'gesetzt. Für Livonia z. B. `dayzOffline.enoch`, für Modkarten den vom Mod gelieferten Template-Namen.',
      '',
      'Wo bearbeiten (Nitrado):',
      '1. **Einstellungen → General → Mission** Dropdown — die offiziellen Karten sind dort hinterlegt.',
      '2. Für Mod-Karten: zuerst den entsprechenden Map-Mod installieren, dann manuell den `template`-String setzen (Dateibrowser).',
      '3. Mission-Wechsel braucht in der Regel einen Charakter-Wipe (`Tools → Datenbank/Charakter zurücksetzen`).',
    ].join('\n'),
  },
  {
    id: 'restart-wartung',
    title: 'Restarts und Wartung',
    triggers: [
      'restart', 'wartung', 'neustart', 'reboot', 'auto restart',
      'autorestart', 'restart zeit', 'wartungsfenster',
    ],
    body: [
      'Auto-Restarts sind im Nitrado-Webinterface unter **Einstellungen → Neustart** konfigurierbar (Cron-artige Zeiten, mehrere pro Tag möglich).',
      'Empfehlung: 4× täglich, gleichmäßig verteilt — DayZ verträgt lange Uptime schlecht (Memory-Drift, Persistenz-Locks).',
      'Vor manuellen Wartungen Spieler im In-Game-Chat warnen (z. B. via RCon-Tool wie *DaRT* oder *BEC*).',
    ].join('\n'),
  },
  {
    id: 'nitrado-grundlagen',
    title: 'Nitrado-Webinterface — Grundlagen',
    triggers: [
      'nitrado', 'webinterface', 'web interface', 'web-interface',
      'kundencenter', 'kundenkonto', 'wo finde ich', 'wie funktioniert nitrado',
      'wie melde ich mich an', 'login nitrado',
    ],
    body: [
      'Wichtigste Bereiche im Nitrado-Webinterface:',
      '- **Übersicht / Status** — Server starten, stoppen, neu starten.',
      '- **Einstellungen → General** — die meisten gameplay-relevanten Felder (Hostname, Passwort, Slots, Zeit-Faktoren, Mission, Mods).',
      '- **Einstellungen → Erweitert** — alles, was nicht ins General-Formular passt.',
      '- **Tools → Dateibrowser** — direkter Zugriff auf alle Server-Dateien (auch `serverDZ.cfg`, `mpmissions/...`).',
      '- **Tools → Backups** — manuelle und automatische Sicherungen.',
      '- **Tools → Mod Manager** — Workshop-Mods installieren (sofern für das Spiel verfügbar).',
      '- **Logs** — `script.log`, `server.RPT`, `crash.log` zur Fehlersuche.',
      '- **Mein Server / Vertragsdetails** — Slots erweitern, Standort wechseln, Verlängern.',
      '',
      'Faustregel: Änderungen werden erst nach **Speichern** UND **Server-Neustart** wirksam.',
    ].join('\n'),
  },
  {
    id: 'logs-debugging',
    title: 'Logs & Fehlersuche',
    triggers: [
      'log', 'logs', 'script.log', 'server.rpt', 'rpt', 'crash',
      'fehler suche', 'fehlersuche', 'debug', 'startet nicht',
    ],
    body: [
      'Wichtige Log-Dateien (Pfad meist `profiles/` oder direkt im Server-Root):',
      '- `*.RPT` — Server-Hauptlog. Stack-Traces beim Absturz, Mod-Lade-Reihenfolge, Mission-Start.',
      '- `script.log` — Compile- und Runtime-Fehler aus `init.c` / Mod-Skripten.',
      '- `*.ADM` — Spieler-Aktivität (Connect/Disconnect, Tod, Schaden, Hit-Logs). Nützlich für Moderation.',
      '- `crash.log` / `*.mdmp` — bei nativen Abstürzen.',
      '',
      'Im Webinterface unter **Logs** einsehbar oder per Dateibrowser herunterladbar. Bei Startproblemen zuerst RPT auf "ERROR"/"WARNING" filtern, dann script.log auf "Cannot compile" prüfen.',
    ].join('\n'),
  },
];

/**
 * Heuristik: Frage zielt auf Nitrado-/DayZ-Server-Hilfe ab?
 * Bewusst weit gefasst — wenn nichts matched liefert lookup leeres Ergebnis.
 */
export function isNitradoOrDayZHelpQuestion(question: string): boolean {
  if (!question) return false;
  const q = question.toLowerCase();
  // Allgemeine Marker, die fast immer auf Server-Themen deuten:
  const general = [
    'dayz', 'nitrado', 'serverdz', 'types.xml', 'events.xml', 'init.c',
    'mpmissions', 'workshop mod', 'rcon', 'battleye',
  ];
  if (general.some((g) => q.includes(g))) return true;
  // Topic-Trigger durchsuchen
  return TOPICS.some((t) => t.triggers.some((tr) => q.includes(tr)));
}

/**
 * Liefert den passenden Hilfeblock. Trifft mehrere Topics zu, werden bis zu
 * 3 zusammengefasst (mehr würde den Prompt aufblähen).
 */
export function lookupNitradoHelp(question: string): HelpAnswer {
  if (!question) return EMPTY;
  const q = question.toLowerCase();

  // Score: Anzahl Trigger-Treffer pro Topic
  const scored = TOPICS.map((t) => {
    let score = 0;
    for (const tr of t.triggers) if (q.includes(tr)) score += 1;
    return { topic: t, score };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return EMPTY;

  const picked = scored.slice(0, 3);
  const lines: string[] = [];
  lines.push('ALLGEMEINE NITRADO/DAYZ-HILFE (generisch — KEINE Daten dieses Servers):');
  lines.push('Diese Erklärungen sind für Einsteiger gedacht. Es handelt sich um allgemeines Wissen über Nitrado und DayZ-Server — NICHT um die Konfiguration des konkreten Servers.');
  lines.push('');
  for (const s of picked) {
    lines.push(`### ${s.topic.title}`);
    lines.push(s.topic.body);
    lines.push('');
  }
  lines.push('REGELN für deine Antwort:');
  lines.push('- Erkläre dem Nutzer den allgemeinen Weg (Webinterface-Pfad, Datei, Schlüssel, Neustart-Hinweis).');
  lines.push('- Nenne NIEMALS konkrete Werte, Hostnames, IPs, Mod-Listen oder Slot-Zahlen DIESES Servers — du kennst sie nicht und sollst sie auch nicht erraten.');
  lines.push('- Wenn der Nutzer nach "unserem Server" / "wie ist es bei uns eingestellt" fragt: ehrlich sagen, dass du keine Server-Internas ausgibst, und stattdessen die generische Anleitung liefern.');
  lines.push('- Halte die Antwort kompakt und an der Frage orientiert. Kein Komplett-Tutorial, wenn nur ein Detail gefragt wurde.');

  return {
    text: lines.join('\n'),
    topicIds: picked.map((s) => s.topic.id),
    found: true,
  };
}
