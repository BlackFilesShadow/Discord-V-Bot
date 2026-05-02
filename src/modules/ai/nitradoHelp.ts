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
      'Wichtige Bereiche (Auswahl, exakte Vanilla-Schlüssel):',
      '- Identität: `hostname`, `password`, `passwordAdmin` (nicht weitergeben!).',
      '- Verbindungslimits: `maxPlayers`, `queueSize`, `loginQueueConcurrentPlayers`, `loginQueueMaxPlayers`.',
      '- Spielzeit: `serverTimeAcceleration`, `serverNightTimeAcceleration`, `serverTimePersistent`, `serverTime`.',
      '- Spielregeln: `disable3rdPerson` (0/1), `disableVoN` (0/1), `enableMouseAndKeyboard` (0/1, Konsolen-Server), `lightingConfig` (0=helle Nächte, 1=Vanilla-Dunkel).',
      '- Hinweis: `disablePersonalLight` ist KEIN serverDZ.cfg-Schlüssel mehr — diese Option steht in `cfgGameplay.json` unter `GeneralData`.',
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
      '2. Spawn-Punkte für ortsfeste Events liegen in `cfgeventspawns.xml` im **Mission-Root** (NICHT in `db/`), Event-Gruppen in `cfgeventgroups.xml`.',
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
  {
    id: 'cfgweather-xml',
    title: 'cfgweather.xml — Wetter, Wind, Regen, Storm',
    triggers: [
      'cfgweather', 'cfgweather.xml', 'weather.xml', 'wetter system',
      'weather', 'wind', 'regen', 'sturm', 'storm', 'fog', 'nebel',
      'overcast', 'rainmag', 'wetter konfiguration', 'wetter einstellen',
      'wetter ändern', 'wetter aendern',
      // Häufige Verwechslung — wer "economy.xml für Wetter" sagt, meint cfgweather.xml:
      'economy.xml', 'economyxml',
    ],
    body: [
      '`cfgweather.xml` liegt im **Mission-Root** (`mpmissions/<mission>/cfgweather.xml`) und steuert das gesamte Wettersystem: Bewölkung, Nebel, Regen, Wind, Sturm.',
      'Aufbau (Vanilla-Schema, gilt für alle Wetter-Elemente außer `<storm>`):',
      '```xml',
      '<weather>',
      '  <overcast>',
      '    <weatherValues defaultValueChangeInterval="600">',
      '      <weatherValueChange weight="50" duration="1200" min="0" mid="0.3" max="0.5"/>',
      '      <weatherValueChange weight="40" duration="1500" min="0.4" mid="0.5" max="0.7"/>',
      '    </weatherValues>',
      '    <forecast forecastTimeMin="600" forecastTimeMax="1200"',
      '              forecastChangeLimitMin="0.3" forecastChangeLimitMax="0.6"/>',
      '  </overcast>',
      '  <fog> ... gleiches Schema ... </fog>',
      '  <rain> ... gleiches Schema ... </rain>',
      '  <wind> ... gleiches Schema, Werte = Windstärke ... </wind>',
      '  <storm rainThreshold="0.7" windThreshold="0.5" timeOut="60"/>',
      '</weather>',
      '```',
      '- `weight` = relative Gewichtung dieses Wertebereichs gegen die anderen Geschwister.',
      '- `duration` = Sekunden, wie lange dieser Zustand gehalten wird.',
      '- `min`/`mid`/`max` = Wertebereich (0–1 für overcast/fog/rain, m/s für wind).',
      '- `defaultValueChangeInterval` = Sekunden bis zum nächsten Übergang.',
      '- `<storm>` ist Single-Element mit Schwellen: ab `rainThreshold` UND `windThreshold` startet ein Gewitter, `timeOut` = Mindestabstand zwischen Gewittern.',
      '',
      'Bearbeiten:',
      '1. **Dateibrowser** → `mpmissions/<mission>/cfgweather.xml`.',
      '2. Werte sanft übergeben — abrupte Wechsel (Sonne → Sturm in 10 s) wirken unnatürlich, größere `<time>`-Fenster nehmen.',
      '3. XML-Validität prüfen, Server-Neustart.',
      '',
      'Hinweis zur Verwechslung: Es gibt KEINE Vanilla-Datei `economy.xml` für Wetter. `cfgeconomycore.xml` (auch Mission-Root) listet nur AUF, welche XML-Dateien die Central Economy lädt. Eine interne Runtime-Datei `economy.xml` taucht im `storage_*`-Persistenz-Ordner auf — die ist auto-generiert und darf NICHT manuell editiert werden.',
    ].join('\n'),
  },
  {
    id: 'cfgenvironment-env-folder',
    title: 'cfgenvironment.xml + env/-Ordner — Tier-Spawns & Animal-Zonen',
    triggers: [
      'cfgenvironment', 'environment.xml', 'enviroment', 'env ordner',
      'env-ordner', 'env folder', 'env/', 'animal spawn', 'tier spawn',
      'cow.xml', 'wolf.xml', 'bear.xml', 'deer.xml', 'animals',
      'env order', 'envzone',
    ],
    body: [
      '`cfgenvironment.xml` liegt im **Mission-Root** (`mpmissions/<mission>/cfgenvironment.xml`) und ist nur ein Index: er listet auf, welche Dateien aus dem `env/`-Unterordner geladen werden.',
      'Aufbau (vereinfacht):',
      '```xml',
      '<environment>',
      '  <files folder="env">',
      '    <file name="zmbterritories.xml" type="zombie"/>',
      '    <file name="animaltracking.xml" type="animal"/>',
      '  </files>',
      '</environment>',
      '```',
      '',
      'Der **`env/`-Ordner** (`mpmissions/<mission>/env/`) enthält die tatsächlichen Zonen-Dateien, z. B.:',
      '- `cattle_territories.xml`, `wolf_territories.xml`, `pigs_territories.xml`, `deer_territories.xml`, `roe_territories.xml`, `goat_territories.xml`, `chicken_territories.xml`, `hare_territories.xml`, `red_fox_territories.xml`, `bear_territories.xml`.',
      '- Pro Datei: `<territories>` → mehrere `<territory color="...">` Blöcke.',
      '- Jede `<territory>` enthält `<zone smin="…" smax="…" dmin="…" dmax="…" areasize="…" x="…" z="…"/>` Einträge.',
      '  - `smin/smax` = Density min/max (Tier-Anzahl-Bandbreite), `dmin/dmax` = Distanz-Range zum Spieler, `areasize` = Radius in Metern, `x/z` = Welt-Koordinaten.',
      '',
      'Bearbeiten:',
      '1. **Dateibrowser** → `mpmissions/<mission>/env/<tier>_territories.xml`.',
      '2. Eigene Zone hinzufügen: neuer `<territory>`-Block mit `<zone>`-Eintrag, Koordinaten aus iZurvive (X/Z).',
      '3. Datei muss in `cfgenvironment.xml` referenziert sein, sonst wird sie ignoriert.',
      '4. Server-Neustart.',
    ].join('\n'),
  },
  {
    id: 'effectarea-xml',
    title: 'effectArea.json / cfgEffectArea.json — Kontaminierte Zonen',
    triggers: [
      'effectarea', 'effect area', 'cfgeffectarea', 'kontaminiert',
      'contamination', 'gas zone', 'gaszone', 'static contaminated',
      'dynamic contaminated', 'toxic',
    ],
    body: [
      '`cfgEffectArea.json` (Vanilla seit DayZ 1.18+, Pfad `mpmissions/<mission>/cfgEffectArea.json`) definiert STATISCHE kontaminierte Zonen (grünes Gas, Partikel, Sound, Damage).',
      'Aufbau auf hohem Level — exakte Feldnamen variieren je DayZ-Version, deshalb IMMER eine Vanilla-Vorlage als Referenz nehmen:',
      '- Wurzel ist ein Array von Areas, jede mit `AreaName` (Bezeichner) und `Type` (z. B. `ContaminatedArea_Static`).',
      '- Ein `Data`-Objekt enthält Position (`Pos` als `[x, y, z]`), Geometrie der Zylinderzone und einen Verweis auf die PPE-Definition.',
      '- Ein `EffectsData`/`Effects`-Objekt referenziert Partikel-, Sound- und Damage-Effekte über deren Class-Names.',
      '- Genaue Pflichtfelder: aus der Vanilla-Datei kopieren statt erfinden.',
      '',
      'DYNAMISCHE Gas-Events (z. B. Heli-Crash mit Gas) liegen in `events.xml` als `DynamicContaminatedArea`.',
      '',
      'Bearbeiten:',
      '1. **Dateibrowser** → `mpmissions/<mission>/cfgEffectArea.json`.',
      '2. JSON-Syntax (Kommas, Klammern, keine Trailing Commas).',
      '3. Schutzmasken-Loot in der Nähe konfigurieren, sonst frustrierend.',
      '4. Server-Neustart.',
    ].join('\n'),
  },
  {
    id: 'cfgundergroundtriggers-json',
    title: 'cfgUndergroundTriggers.json — Bunker-Trigger',
    triggers: [
      'cfgundergroundtriggers', 'underground triggers', 'underground trigger',
      'bunker trigger', 'bunker', 'subterranean', 'underground.json',
    ],
    body: [
      '`cfgUndergroundTriggers.json` (DayZ 1.25+ mit dem Frostline-DLC eingeführt, Pfad `mpmissions/<mission>/cfgUndergroundTriggers.json`) definiert WO ein Bunker-/Höhlen-Eingang den unterirdischen Render-/Ambient-Modus aktiviert (gedämpfter Sound, Dunkelheit, eigene Partikel).',
      'Pro Eintrag:',
      '- `name` — Bezeichner.',
      '- `data` mit `Position` `[x, y, z]`, `OrientationYPR`, und Geometrie-Box (`SizeX`, `SizeY`, `SizeZ`).',
      '- `InterpolationSpeed` — wie schnell der Übergang vom Außen- zum Unterwelt-Sound stattfindet.',
      '- `AmbientSoundsetInside` / `AmbientSoundsetOutside` — Class-Names der Soundsets.',
      '',
      'Bearbeiten:',
      '1. **Dateibrowser** → `mpmissions/<mission>/cfgUndergroundTriggers.json`.',
      '2. Box-Geometrie groß genug wählen, sonst flackert der Audio-Übergang am Türrahmen.',
      '3. JSON valide halten — Server startet sonst die Mission nicht.',
      '4. Server-Neustart.',
    ].join('\n'),
  },
  {
    id: 'cfggameplay-json',
    title: 'cfgGameplay.json — Gameplay-Tweaks zentral',
    triggers: [
      'cfggameplay', 'cfggameplay.json', 'gameplay.json', 'gameplay tweaks',
      'gameplay config', 'stamina', 'sprint speed', 'shock', 'crosshair',
      'spawn gear', 'starter gear', 'mapwidget',
    ],
    body: [
      '`cfgGameplay.json` (Mission-Root) ist der zentrale Vanilla-Schalter für Gameplay-Anpassungen ohne Code-Mod. Geladen automatisch wenn vorhanden.',
      'Wichtige Sektionen:',
      '- `GeneralData` — `disableRespawnDialog`, `disableRespawnInUnconsciousness`, `disablePersonalLight`.',
      '- `PlayerData` — Hunger/Durst/Health-Multiplier, Sprint-Speed, Stamina-Caps.',
      '- `ShockHandlingData` — Schock-Decay, Bewusstlosigkeits-Schwellen.',
      '- `MovementData` — Sprintbarrieren, Sprung-Energie.',
      '- `UIData` — `useMapGPSPosition`, `useMapPlayerPosition`, `crosshair`, `disableHUD`.',
      '- `MapData` — `displayServerInfo`, sichtbare HUD-Elemente, World-Marker.',
      '- `WorldData` — Lighting-Multiplier (Tag/Nacht-Helligkeit), Lightning-Probability.',
      '- `PlayerSpawnGearPresets` + `PlayerRestrictedAreas` — Spawn-Loadout-Slots, verbotene Areale (PvE-Zonen).',
      '',
      'Bearbeiten:',
      '1. **Dateibrowser** → `mpmissions/<mission>/cfgGameplay.json`.',
      '2. JSON valide (Kommas!), Vanilla-Vorlage als Backup behalten.',
      '3. Werte außerhalb der Vanilla-Range wirken sich oft nichtlinear aus — kleine Schritte testen.',
      '4. Server-Neustart.',
    ].join('\n'),
  },
  {
    id: 'mapgroupproto-pos-xml',
    title: 'mapgroupproto.xml + mapgrouppos.xml — Loot-Container & Positionen',
    triggers: [
      'mapgroupproto', 'mapgroup proto', 'mapgrouppos', 'mapgroup pos',
      'mapgroupos', 'loot container', 'lootspawn', 'building loot',
      'static loot', 'dynamic_event_loot',
      // Deutsche Varianten für "Wo wird Loot in Häusern definiert":
      'loot in häusern', 'loot in haeusern', 'loot in gebäude', 'loot in gebaeude',
      'loot in gebäuden', 'loot in gebaeuden', 'haus loot', 'haus-loot',
      'gebäude loot', 'gebaeude loot', 'gebäudeloot', 'gebaeudeloot',
      'loot punkte', 'loot-punkte', 'lootpunkte', 'spawn punkte',
      'wo wird loot', 'wo spawnt loot', 'wo spawnt der loot',
      'wo liegt loot', 'wo liegt der loot', 'loot positionen', 'loot-positionen',
      'loot definiert', 'loot festgelegt',
    ],
    body: [
      '`mapgroupproto.xml` und `mapgrouppos.xml` arbeiten zusammen, um Loot in Gebäude zu legen. Beide liegen im **Mission-Root**, NICHT in `db/`.',
      '',
      '`mapgroupproto.xml` (`mpmissions/<mission>/mapgroupproto.xml`) ist die TYP-Definition:',
      '- `<group name="Land_City_Hospital">` — pro Gebäude-Klasse ein Block.',
      '- `<container name="default">` mit `<point x="…" y="…" z="…" range="…"/>` — Loot-Spawn-Punkte RELATIV zum Gebäude.',
      '- `<usage name="Medic"/>`, `<value name="Tier2"/>` — Filter, welche `types.xml`-Items hier spawnen dürfen.',
      '- `<lootmax max="…"/>` — Cap pro Gebäude.',
      '',
      '`mapgrouppos.xml` (`mpmissions/<mission>/mapgrouppos.xml`) ist die WELT-Liste:',
      '- `<group name="Land_City_Hospital" pos="X Z Y" rpy="r p y" a="a"/>` — jeder Eintrag = ein KONKRETES Gebäude an Welt-Koordinaten.',
      '- Wird automatisch aus dem Map-Build generiert; meist NICHT manuell editieren.',
      '',
      'Bearbeiten:',
      '1. Loot-Punkte ändern → `mapgroupproto.xml` editieren.',
      '2. Gebäude wurde verschoben/hinzugefügt (nur Mod-Maps relevant) → `mapgrouppos.xml`.',
      '3. **Tools wie *DayZ Loot Editor* oder *Mapgroup Editor*** sparen massiv Zeit.',
      '4. Server-Neustart, danach `script.log` auf "could not find proto" prüfen.',
    ].join('\n'),
  },
  {
    id: 'cfgspawnabletypes-xml',
    title: 'cfgspawnabletypes.xml — Loot-Inhalte (Munition, Anbauteile, Kleidung)',
    triggers: [
      'cfgspawnabletypes', 'spawnable types', 'spawnabletypes',
      'spawntabletypes', 'cargo loot', 'attachment loot', 'mag loot',
      'magazin spawn', 'kleidung loot',
      // ACHTUNG: KEIN "loot"-Catchall — sonst frisst dieses Topic
      // jede Loot-Frage und verdrängt mapgroupproto (das ist die richtige
      // Datei für "Loot in Häusern").
      'was steckt im item', 'item inhalt', 'cargo befüllung', 'cargo befuellung',
    ],
    body: [
      '`cfgspawnabletypes.xml` liegt im **Mission-Root** (`mpmissions/<mission>/cfgspawnabletypes.xml`, NICHT in `db/`) und bestimmt, mit WAS ein gespawntes Item befüllt wird.',
      '- Ein Magazin spawnt voll/teilweise gefüllt? Eine Jacke mit Patches? Eine Waffe mit Optik?',
      '',
      'Aufbau pro Item:',
      '```',
      '<type name="AKM">',
      '  <attachments chance="0.30">',
      '    <item name="AK_WoodBttstck" chance="0.50"/>',
      '    <item name="AK_PlasticBttstck" chance="0.50"/>',
      '  </attachments>',
      '  <cargo chance="0.10">',
      '    <item name="Mag_AKM_30Rnd" chance="1.00"/>',
      '  </cargo>',
      '</type>',
      '```',
      '- `chance` auf `<attachments>` / `<cargo>` = Wahrscheinlichkeit, dass DIESE Slot-Gruppe überhaupt befüllt wird.',
      '- `chance` auf `<item>` = relative Gewichtung innerhalb der Gruppe.',
      '- Verknüpfte Datei: `cfgrandompresets.xml` (auch Mission-Root) gruppiert mehrere `<item>`-Listen unter einem Preset-Namen, der dann hier referenziert werden kann.',
      '',
      'Bearbeiten:',
      '1. **Dateibrowser** → genannter Pfad.',
      '2. Item-Klassen müssen exakt mit `types.xml` übereinstimmen, sonst NULL-Spawn ohne Fehlermeldung.',
      '3. XML-Validität, Server-Neustart.',
    ].join('\n'),
  },
  {
    id: 'automatic-tasks',
    title: 'Automatische Tasks (Cron, Restart, Backup)',
    triggers: [
      'automatic task', 'auto task', 'task scheduler', 'cron job',
      'cronjob', 'geplante aufgabe', 'auto backup', 'auto-backup',
      'rcon scheduler', 'tasks',
    ],
    body: [
      'Im Nitrado-Webinterface gibt es **Tasks / Aufgaben** (manchmal "Auto-Tasks"):',
      '- **Restart** — periodische Server-Neustarts mit optionaler Vorwarnung im Spiel-Chat.',
      '- **Befehl ausführen** — RCon-Kommandos zu fixen Zeiten (`#shutdown`, `#kick all`, eigene Mod-Cmds).',
      '- **Datei-Aktion** — z. B. Logs rotieren, Datei kopieren.',
      '- **Backup** — manuelles Snapshot-Anstoßen (Voll-Backup der Server-Dateien).',
      '',
      'Wo:',
      '1. **Einstellungen → Neustart** (für Restart-Cron).',
      '2. **Tools → Auto-Tasks** (für sonstige geplante Aufgaben).',
      '3. **Tools → Backups** (manuelle Sicherung + Aufbewahrungs-Limit).',
      '',
      'Faustregeln:',
      '- 3–4 Restarts pro Tag, gleichmäßig verteilt.',
      '- Backup VOR jedem größeren Konfig-Eingriff (`types.xml`, `init.c`, Mod-Update).',
      '- Restart-Vorwarnung **2 Min** im Chat ankündigen, sonst hagelt es Beschwerden.',
    ].join('\n'),
  },
  {
    id: 'dashboard-meanings',
    title: 'Nitrado-Dashboard — Bedeutung der Anzeigen',
    triggers: [
      'dashboard', 'übersicht', 'uebersicht', 'status anzeige',
      'cpu auslastung', 'ram auslastung', 'speicher anzeige',
      'spieler anzeige', 'fps anzeige', 'tickrate', 'ping anzeige',
    ],
    body: [
      'Typische Anzeigen im Nitrado-Dashboard und was sie bedeuten:',
      '- **Status (grün/gelb/rot)** — Prozess läuft / startet / abgestürzt.',
      '- **Online seit** — Uptime seit letztem Start. Wert > 24h ist bei DayZ ein Warnsignal (Memory-Drift).',
      '- **Spieler / Slots** — aktuell verbunden / max gemietet (nicht `maxPlayers` aus Cfg).',
      '- **CPU-Last** — Vanilla DayZ idlet 5–15 %, Spieler/Mods treiben das nach oben. > 90 % dauerhaft = Tickrate sinkt.',
      '- **RAM** — DayZ Vanilla ~3 GB, mit Mods 5–8 GB normal. Steigt monoton an → Restart nötig.',
      '- **Tickrate / FPS** — Server-FPS, Ziel 30+. < 15 = spürbares Lag.',
      '- **Ping zum Server** — Latenz zwischen Nitrado-Standort und Spieler.',
      '- **Mod-Status / Workshop-Updates** — Hinweis wenn ein abonnierter Mod ein Update hat (Server muss aktualisieren).',
      '',
      'Hinweise:',
      '- Ein roter Status nach Konfig-Änderung deutet meist auf Syntax-Fehler in `serverDZ.cfg`, `init.c` oder einer XML hin → `script.log` / RPT.',
      '- Spieler-Anzahl im Dashboard kann 30–60 s nachhängen (Polling).',
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
    'cfgweather', 'cfgenvironment', 'cfgeffectarea', 'effectarea',
    'cfgundergroundtriggers', 'cfggameplay', 'mapgroupproto', 'mapgrouppos',
    'cfgspawnabletypes', 'cfgrandompresets', 'cfgeconomycore', 'cfgeventspawns',
    'cfgeventgroups', 'auto-task', 'auto task', 'cron job',
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
  lines.push('');
  lines.push('DAYZ-DATEI-WAHRHEIT (HARTE REGELN — Halluzinationen werden als Fehler gewertet):');
  lines.push('- Im **Mission-Root** (`mpmissions/<mission>/`) liegen: init.c, mapgroupproto.xml, mapgrouppos.xml, cfgspawnabletypes.xml, cfgrandompresets.xml, cfgweather.xml, cfgenvironment.xml, cfgeventspawns.xml, cfgeventgroups.xml, cfgeconomycore.xml, cfglimitsdefinition.xml, cfglimitsdefinitionuser.xml, cfgEffectArea.json, cfgUndergroundTriggers.json, cfgGameplay.json. Außerdem der Unterordner `env/` (Tier-Zonen).');
  lines.push('- Im **`db/`-Unterordner** (`mpmissions/<mission>/db/`) liegen NUR: types.xml, events.xml, messages.xml, globals.xml.');
  lines.push('- Eine Vanilla-Datei `economy.xml` für WETTER existiert NICHT. Wetter steht in `cfgweather.xml`. Die Datei `economy.xml` taucht nur als auto-generierte Runtime-Datei im `storage_*`-Persistenz-Ordner auf und darf NICHT manuell editiert werden.');
  lines.push('- DayZ verwendet für Mission-Configs überwiegend XML. JSON nur für: cfgEffectArea.json, cfgUndergroundTriggers.json, cfgGameplay.json. ALLE anderen Mission-Configs sind XML.');
  lines.push('- Es gibt KEINE Datei "cfgSpawnableTypes.json", kein Verzeichnis "cfgSpawnableTypes/building/", kein "cfgSpawnableTypes/itemsets/". Wer das sagt, halluziniert (das ist Arma3-/ExileMod-Syntax und gilt NICHT für DayZ Standalone).');
  lines.push('- Loot in Gebäuden = `mapgroupproto.xml` (Loot-Punkte je Gebäudetyp) + `mapgrouppos.xml` (Welt-Positionen). Felder dort: `<container>`, `<point x y z range>`, `<usage>`, `<value>`, `<lootmax>`. KEIN spawnChance/minCount/maxCount/itemSet/offsetX/Y/Z.');
  lines.push('- Cargo/Attachments für gespawnte Items = `cfgspawnabletypes.xml` (XML, NICHT JSON). Felder: `<type name>`, `<attachments chance>`, `<cargo chance>`, `<item name chance>`.');
  lines.push('- Loot-Mengen pro Item = `db/types.xml`. Felder: `nominal`, `min`, `lifetime`, `restock`, `<flags>`, `<usage>`, `<value>`, `<tag>`. Es gibt KEIN `spawnChance` in types.xml.');
  lines.push('- Wenn du dir bei einem Dateinamen, Pfad oder Feld unsicher bist: sage "das müsste ich nachschlagen" statt zu raten. Lieber kurz und korrekt als ausführlich und falsch.');

  return {
    text: lines.join('\n'),
    topicIds: picked.map((s) => s.topic.id),
    found: true,
  };
}

/**
 * Statischer Anti-Halluzinations-Block. Wird zus\u00e4tzlich injiziert, wenn die
 * Frage erkennbar nach DayZ-Dateien klingt aber kein Topic eindeutig getroffen
 * wurde \u2014 verhindert dass die LLM Arma3-/ExileMod-Felder oder erfundene
 * Dateinamen wie "cfgSpawnableTypes.json" hervorbringt.
 */
const FILE_TRUTH_BLOCK: string = [
  'DAYZ-DATEI-WAHRHEIT (HARTE REGELN — Halluzinationen werden als Fehler gewertet):',
  '- Im **Mission-Root** (`mpmissions/<mission>/`) liegen: init.c, mapgroupproto.xml, mapgrouppos.xml, cfgspawnabletypes.xml, cfgrandompresets.xml, cfgweather.xml, cfgenvironment.xml, cfgeventspawns.xml, cfgeventgroups.xml, cfgeconomycore.xml, cfglimitsdefinition.xml, cfglimitsdefinitionuser.xml, cfgEffectArea.json, cfgUndergroundTriggers.json, cfgGameplay.json. Außerdem der Unterordner `env/` (Tier-Zonen).',
  '- Im **`db/`-Unterordner** (`mpmissions/<mission>/db/`) liegen NUR: types.xml, events.xml, messages.xml, globals.xml.',
  '- Eine Vanilla-Datei `economy.xml` für WETTER existiert NICHT. Wetter steht in `cfgweather.xml`. Die Datei `economy.xml` taucht nur als auto-generierte Runtime-Datei im `storage_*`-Persistenz-Ordner auf und darf NICHT manuell editiert werden.',
  '- DayZ verwendet für Mission-Configs überwiegend XML. JSON nur für: cfgEffectArea.json, cfgUndergroundTriggers.json, cfgGameplay.json. ALLE anderen Mission-Configs sind XML.',
  '- Es gibt KEINE Datei "cfgSpawnableTypes.json", kein Verzeichnis "cfgSpawnableTypes/building/", kein "cfgSpawnableTypes/itemsets/". Wer das sagt, halluziniert (das ist Arma3-/ExileMod-Syntax und gilt NICHT für DayZ Standalone).',
  '- Loot in Gebäuden = `mapgroupproto.xml` (Loot-Punkte je Gebäudetyp) + `mapgrouppos.xml` (Welt-Positionen). Felder dort: `<container>`, `<point x y z range>`, `<usage>`, `<value>`, `<lootmax>`. KEIN spawnChance/minCount/maxCount/itemSet/offsetX/Y/Z.',
  '- Cargo/Attachments für gespawnte Items = `cfgspawnabletypes.xml` (XML, NICHT JSON). Felder: `<type name>`, `<attachments chance>`, `<cargo chance>`, `<item name chance>`.',
  '- Loot-Mengen pro Item = `db/types.xml`. Felder: `nominal`, `min`, `lifetime`, `restock`, `<flags>`, `<usage>`, `<value>`, `<tag>`. Es gibt KEIN `spawnChance` in types.xml.',
  '- Wenn du dir bei einem Dateinamen, Pfad oder Feld unsicher bist: sage "das müsste ich nachschlagen" statt zu raten. Lieber kurz und korrekt als ausführlich und falsch.',
].join('\n');

/**
 * Liefert nur den Wahrheits-Block (ohne Topic), z.\u202fB. wenn die Frage nach
 * einer DayZ-Datei klingt aber kein Topic-Trigger getroffen hat. Verhindert,
 * dass die LLM frei halluziniert.
 */
export function getDayZFileTruthBlock(): string {
  return FILE_TRUTH_BLOCK;
}

/**
 * Heuristik: klingt die Frage nach DayZ-Datei/Konfig (auch wenn kein Topic matched)?
 * Wenn ja, soll der Wahrheits-Block injiziert werden.
 */
export function looksLikeDayZFileQuestion(question: string): boolean {
  if (!question) return false;
  const q = question.toLowerCase();
  // Dateiname-Stems, die nur in DayZ vorkommen \u2014 dann ist es eine DayZ-Frage,
  // egal wie die Frage formuliert ist.
  if (/\b(types\.xml|events\.xml|economy\.xml|cfgweather|init\.c|serverdz\.cfg|mapgroupproto|mapgrouppos|cfgspawnabletypes|cfggameplay|cfgeffectarea|cfgundergroundtriggers|cfgenvironment|cfgrandompresets|cfgeconomycore|cfgeventspawns|cfgeventgroups)\b/.test(q)) {
    return true;
  }
  // Datei-Endungen im DayZ-/Nitrado-/Loot-Kontext
  if (/\.(xml|cfg|json|c)\b/.test(q) && /(dayz|nitrado|loot|spawn|mod|server|item|geb\u00e4ude|gebaeude|haus|h\u00e4user|haeuser|mission)/.test(q)) {
    return true;
  }
  // \"Loot in H\u00e4usern\", \"wo wird X definiert\", \"welche Datei\"
  if (/\bloot\b.*\b(h\u00e4user|haeuser|geb\u00e4ude|gebaeude|haus)\b/.test(q)) return true;
  if (/\bwelche\s+datei\b/.test(q) && /(loot|spawn|item|mod|dayz|server|geb\u00e4ude|gebaeude|wetter|tier)/.test(q)) return true;
  if (/\bwo\s+(wird|werden|spawnt|spawnen|liegt|liegen|finde|find\s+ich)\b/.test(q) && /(loot|item|spawn|geb\u00e4ude|gebaeude|haus|h\u00e4user|haeuser|tier|wetter)/.test(q)) return true;
  return false;
}
