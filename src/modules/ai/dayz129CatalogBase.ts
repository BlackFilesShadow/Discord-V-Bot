import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { DAYZ129_INDEX_GZIP_BASE64, DAYZ129_INDEX_GZIP_BASE64_SHA256 } from './generated/dayz129IndexData';

export type Dayz129Map = 'chernarus' | 'livonia' | 'sakhal';

type Scalar = string | number | boolean | null;
type RecordValue = Scalar | Scalar[] | Record<string, Scalar> | Record<string, Scalar>[];

interface IndexedFile {
  size: number;
  sha256: string;
  structure: {
    root?: string;
    rootType?: string;
    format?: string;
    elementCounts?: Record<string, number>;
    attributeCounts?: Record<string, number>;
    topLevelTags?: Record<string, number>;
    keyPaths?: Record<string, number>;
  };
}

export interface Dayz129TerritoryZone {
  name: string;
  count: number;
  dminMin: number;
  dminMax: number;
  dmaxMin: number;
  dmaxMax: number;
  radiusMin: number;
  radiusMax: number;
}

export interface Dayz129EffectArea {
  name: string | null;
  type: string | null;
  triggerType: string | null;
  radius: number | null;
  posHeight: number | null;
  negHeight: number | null;
}

export interface Dayz129RandomPreset {
  kind: 'cargo' | 'attachments';
  chance: number | null;
  items: Array<{ name: string; chance: number | null }>;
}

export interface Dayz129SpawnableType {
  hoarder?: true;
  damage?: Record<string, Scalar>;
  attachments?: Array<{ chance: number | null; items?: string[]; preset?: string }>;
  cargo?: Array<{ chance: number | null; items?: string[]; preset?: string }>;
}

interface IndexedMap {
  mission: string;
  files: Record<string, IndexedFile>;
  types: Record<string, Record<string, RecordValue>>;
  events: Record<string, Record<string, RecordValue>>;
  /** Rohe `<var name/type/value>`-Eintraege aus db/globals.xml. */
  globals?: Record<string, { type: number | null; value: Scalar }>;
  /** Init/Load/Respawn/Save-Flags je CE-Wurzelklasse aus db/economy.xml. */
  economyClasses?: Record<string, { init: number; load: number; respawn: number; save: number }>;
  /** Rootclasses + Default-Parameter aus cfgeconomycore.xml. */
  economyCore?: { rootClasses: Array<Record<string, string>>; defaults: Record<string, Scalar> };
  /** Weather-Konfiguration aus cfgweather.xml (reset/enable + je Sektion current/limits/timelimits/changelimits/thresholds). */
  weather?: { reset: number | null; enable: number | null; sections: Record<string, Record<string, Record<string, Scalar>>> };
  /** Die vollstaendige, verbindliche Namensliste aus cfglimitsdefinition.xml. */
  limitsDefinition?: { categories: string[]; tags: string[]; usageflags: string[]; valueflags: string[] };
  /** Benutzerdefinierte Sammel-Flags (z.B. "TownVillage") aus cfglimitsdefinitionuser.xml. */
  limitsDefinitionUser?: { usageflags: Record<string, string[]>; valueflags: Record<string, string[]> };
  /** Von der CE ignorierte Classnames aus cfgignorelist.xml. */
  ignoreList?: string[];
  /** Aktive (nicht auskommentierte) Server-Messages aus db/messages.xml. */
  messages?: Array<{ delay?: number; repeat?: number; deadline?: number; shutdown?: number; onconnect?: number; text?: string }>;
  /** Aggregierte Zonen je Tier-/Zombie-Territoriumsdatei (env/*_territories.xml), OHNE Einzelkoordinaten. */
  territories?: Record<string, Dayz129TerritoryZone[]>;
  /** Gruppe -> Kind-Classname -> Anzahl aus cfgeventgroups.xml, OHNE Koordinaten. */
  eventGroups?: Record<string, Record<string, number>>;
  /** Cargo-/Attachment-Presets aus cfgrandompresets.xml. */
  randomPresets?: Record<string, Dayz129RandomPreset>;
  /** Statische Kontaminationsbereiche aus cfgeffectarea.json. */
  effectAreas?: { areas: Dayz129EffectArea[]; safePositionCount: number };
  /** Spawn-Attachment-/Cargo-Zuordnungen aus cfgspawnabletypes.xml. */
  spawnableTypes?: Record<string, Dayz129SpawnableType>;
  /** Generator-/Spawn-Parameter je fresh/hop/travel aus cfgplayerspawnpoints.xml, OHNE Koordinaten. */
  playerSpawnPoints?: Record<string, Record<string, Record<string, Scalar>>>;
}

export interface Dayz129Index {
  version: string;
  sourceTag: string;
  verifiedAgainstUserManifest?: boolean;
  maps: Record<Dayz129Map, IndexedMap>;
  allFileBasenames: string[];
  allRelativePaths: string[];
  allTypeNames: string[];
  allEventNames: string[];
}

export interface DayzCatalogAnswer {
  answer: string;
  topic: 'file' | 'type' | 'event' | 'unknown-file' | 'type-search' | 'event-search';
  ids: string[];
}

let cached: Dayz129Index | null = null;
let typeByLower: Map<string, string> | null = null;
let eventByLower: Map<string, string> | null = null;

export const DAYZ129_PROVENANCE = {
  valueAndStructureSource: 'three user-supplied DayZ 1.29.163451 ZIP datasets',
  officialSemanticReference: 'Bohemia DayZ documentation / DZ_129 where applicable',
  rule: 'user ZIP values are never replaced by public-repository values when they differ',
} as const;

const MAP_LABELS: Record<Dayz129Map, string> = {
  chernarus: 'Chernarus',
  livonia: 'Livonia',
  sakhal: 'Sakhal',
};

export function getDayz129Index(): Dayz129Index {
  if (!cached) {
    // Der eingebettete Payload wurde in diesem Repo schon einmal spaet im
    // komprimierten Stream beschaedigt (siehe generate_dayz129_index.py). Ein
    // SHA-256 ueber die rohe Base64-Nutzlast erkennt eine kuenftige
    // Beschaedigung sofort und fail-closed, statt still fehlerhafte oder
    // teilweise Daten als Wissensbasis zu laden.
    const actualSha256 = createHash('sha256').update(DAYZ129_INDEX_GZIP_BASE64, 'ascii').digest('hex');
    if (actualSha256 !== DAYZ129_INDEX_GZIP_BASE64_SHA256) {
      throw new Error(
        `DayZ-1.29-Index-Payload beschaedigt: SHA-256 ${actualSha256} weicht von erwartetem ${DAYZ129_INDEX_GZIP_BASE64_SHA256} ab.`,
      );
    }
    const raw = gunzipSync(Buffer.from(DAYZ129_INDEX_GZIP_BASE64, 'base64')).toString('utf8');
    cached = JSON.parse(raw) as Dayz129Index;
    cached.sourceTag = 'USER_ZIPS_1.29.163451';
    typeByLower = new Map(cached.allTypeNames.map((name) => [name.toLocaleLowerCase('de-DE'), name]));
    eventByLower = new Map(cached.allEventNames.map((name) => [name.toLocaleLowerCase('de-DE'), name]));
  }
  return cached;
}

function fold(text: string): string {
  return text
    .toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function compact(text: string): string { return fold(text).replace(/[^a-z0-9]+/g, ''); }

function splitIdentifier(text: string): string[] {
  const expanded = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([A-Za-z])/g, '$1 $2');
  return fold(expanded).split(/[^a-z0-9]+/).filter(Boolean);
}

function detectMaps(question: string): Dayz129Map[] {
  const q = fold(question);
  const out: Dayz129Map[] = [];
  if (/\b(chernarus|chernarusplus)\b/.test(q)) out.push('chernarus');
  if (/\b(livonia|enoch)\b/.test(q)) out.push('livonia');
  if (/\b(sakhal|frostline)\b/.test(q)) out.push('sakhal');
  return out;
}

const FILE_ALIASES: Record<string, string> = {
  'type.xml': 'db/types.xml', 'types.xml': 'db/types.xml', 'typesxml': 'db/types.xml',
  'event.xml': 'db/events.xml', 'events.xml': 'db/events.xml', 'eventxml': 'db/events.xml', 'eventsxml': 'db/events.xml',
  'message.xml': 'db/messages.xml', 'messages.xml': 'db/messages.xml', 'messagexml': 'db/messages.xml', 'messagesxml': 'db/messages.xml',
  'global.xml': 'db/globals.xml', 'globals.xml': 'db/globals.xml', 'globalxml': 'db/globals.xml', 'globalsxml': 'db/globals.xml',
  'economy.xml': 'db/economy.xml', 'economyxml': 'db/economy.xml',
};

const FILE_PURPOSES: Record<string, string> = {
  'db/types.xml': 'definiert die von der Central Economy verwalteten Typen und deren CE-Limiter bzw. Spawn-/Lebensdauer-Felder wie `nominal`, `min`, `lifetime`, `restock`, Flags sowie `category`, `usage`, `value` und `tag`.',
  'db/events.xml': 'definiert dynamische Central-Economy-Events. Dazu gehoeren in den drei Datensaetzen unter anderem Fahrzeuge, Tiere, Infected und statische Events. Eventregeln und Children stehen hier; vorgesehene Weltpositionen positionsbasierter Events liegen getrennt in `cfgeventspawns.xml`.',
  'db/globals.xml': 'enthaelt globale Central-Economy-Variablen fuer Limits, Cleanup, Respawn, Login und Flag-Refresh-Verhalten.',
  'db/messages.xml': 'definiert Server-Messages. Die in den gelieferten Chernarus-/Livonia-Dateien dokumentierten Felder sind `delay`, `repeat`, `deadline`, `onconnect`, `shutdown` und `text`; dokumentierte Platzhalter sind `#name` und `#tmin` (Bohemias Server-Messages-Doku kennt ausserdem `#port`).',
  'db/economy.xml': 'konfiguriert fuer Economy-Klassen bzw. Entity-Gruppen, ob sie von der CE initialisiert, geladen, gespeichert und respawnt werden.',
  'cfgeconomycore.xml': 'ist die Grundkonfiguration der Central Economy: Rootklassen, Defaults, Persistence-/Logging-Einstellungen und Einbindung zusaetzlicher CE-Dateien zum Append/Override.',
  'cfgenvironment.xml': 'verknuepft Tier-/Infected-Umgebungsdefinitionen mit den kartenbezogenen Territory-Dateien unter `env/`.',
  'cfgeventgroups.xml': 'beschreibt gruppierte Objekt-/Child-Anordnungen, die von entsprechenden Events verwendet werden koennen.',
  'cfgeventspawns.xml': 'enthaelt Positionen und Rotationen/Zonen fuer positionsbasierte dynamische Events, z. B. Fahrzeug- oder Heli-Crash-Spawns.',
  'cfggameplay.json': 'enthaelt missionsbezogene Gameplay Settings. Bohemia laedt sie nur, wenn die aktive Server-Konfiguration `enableCfgGameplayFile = 1;` setzt.',
  'cfgignorelist.xml': 'enthaelt eine Liste von Typnamen, die in diesem CE-Kontext als Ignore-Liste gefuehrt werden. V-Bot leitet aus dem Dateinamen keine weitergehende Wirkung ab, die nicht belegt ist.',
  'cfglimitsdefinition.xml': 'definiert Namen/Definitionen der CE-Limiter fuer Usage, Value, Tag und Category.',
  'cfglimitsdefinitionuser.xml': 'enthaelt benutzerfreundliche bzw. kombinierte Limiter-Definitionen, die auf den Definitionen aus `cfglimitsdefinition.xml` aufbauen koennen.',
  'cfgplayerspawnpoints.xml': 'definiert Regeln und Basispunkte fuer Player-Spawns. Bohemia trennt Bereiche fuer Fresh-, Hop- und Travel-Spawns.',
  'cfgrandompresets.xml': 'definiert wiederverwendbare Presets fuer zufaellige Cargo- und Attachment-Zusammenstellungen.',
  'cfgspawnabletypes.xml': 'definiert zufaellige Cargo-Inhalte und Attachments fuer Typen und kann Presets aus `cfgrandompresets.xml` referenzieren.',
  'cfgundergroundtriggers.json': 'definiert Underground-`Triggers` und `Breadcrumbs`; Bohemia nutzt sie unter anderem fuer Praesenz-/Dunkelheits- bzw. Eye-Accommodation-Logik in Untergrundbereichen.',
  'cfgweather.xml': 'konfiguriert das Missionswetter, unter anderem Overcast, Fog, Rain, Wind, Snowfall und Storm soweit die jeweilige Karte diese Bereiche nutzt.',
  'cfgeffectarea.json': 'definiert statische Effect-/Kontaminationsbereiche. Dynamische Kontaminationszonen werden dagegen ueber CE-Events erzeugt.',
  'areaflags.map': 'ist eine optionale binaere Ausgabe des Central-Economy-Tools. Bohemia beschreibt sie als Moeglichkeit, Mapgroups/Buildings Usage- oder Value-Flags fuer Loot-Limitierung zuzuordnen.',
  'mapclusterproto.xml': 'definiert Cluster-Mapgroup-Prototypen. Die zugehoerigen `mapgroupcluster*.xml`-Dateien enthalten exportierte Instanzen/Positionen.',
  'mapgroupdirt.xml': 'ist eine Mapgroup-Positionsdatei. In den drei gelieferten Datensaetzen ist sie strukturell praktisch leer; V-Bot erfindet daraus keine zusaetzliche Gameplay-Funktion.',
  'mapgrouppos.xml': 'enthaelt exportierte Weltpositionen der Mapgroups/Buildings, die zu den Prototypen aus `mapgroupproto.xml` gehoeren.',
  'mapgroupproto.xml': 'beschreibt Mapgroup-/Gebaeude-Prototypen inklusive der fuer CE-Loot relevanten Container-/Spawn-Struktur.',
  'build.xml': 'ist im gelieferten Sakhal-Datensatz ein Build-/Projekt-Descriptor und keine normale Gameplay-Konfigurationsdatei. V-Bot behandelt ihn deshalb nicht wie eine CE-Balancing-Datei.',
  'pra/warheadstorage.json': 'ist im Sakhal-Datensatz eine Player-Restricted-Area-Datei (`RestrictedAreaWarheadStorage`) und wird dort ueber `cfggameplay.json`/`playerRestrictedAreaFiles` referenziert.',
};

function purposeFor(path: string): string {
  const key = path.toLocaleLowerCase('de-DE');
  if (FILE_PURPOSES[key]) return FILE_PURPOSES[key];
  if (/^env\/.+_territories\.xml$/.test(key)) return 'enthaelt kartenbezogene Territory-Zonen/Positionen fuer die im Dateinamen bezeichnete Tier- oder Infected-Population.';
  if (/^mapgroupcluster\d*\.xml$/.test(key)) return 'enthaelt exportierte Cluster-Mapgroup-Instanzen/Positionen; die Aufteilung auf nummerierte Dateien ist kartenabhaengig.';
  return 'ist in mindestens einem der drei gelieferten 1.29-Datensaetze vorhanden. Fuer eine weitergehende Funktionsaussage ist in der eingebetteten Wissensbasis keine sichere Semantik hinterlegt; V-Bot beschreibt deshalb nur die belegte Struktur und das Karten-Vorkommen.';
}

function canonicalFileFromText(question: string): string | null {
  const index = getDayz129Index();
  const q = fold(question).replace(/\\/g, '/');
  const paths = [...index.allRelativePaths].sort((a, b) => b.length - a.length);

  // Prefer complete indexed paths before any short aliases. This prevents names
  // such as cfgspawnabletypes.xml from being mistaken for db/types.xml.
  for (const path of paths) {
    if (q.includes(fold(path))) return path;
  }

  // If the question contains a concrete filename, resolve that token exactly.
  // Unknown filenames must remain unknown instead of matching a suffix alias.
  const explicitFile = explicitFileLikeToken(question);
  if (explicitFile) {
    const explicit = fold(explicitFile).replace(/\\/g, '/');
    for (const path of paths) {
      const basename = path.split('/').pop()!;
      if (explicit === fold(path) || explicit === fold(basename)) return path;
    }
    const aliasTarget = FILE_ALIASES[explicit] ?? FILE_ALIASES[compact(explicitFile)];
    return aliasTarget ?? null;
  }

  for (const path of paths) {
    const basename = path.split('/').pop()!;
    if (q.includes(fold(basename))) return path;
  }

  // Dot-less convenience forms such as "typesxml" are accepted only as
  // standalone tokens, never as substrings of another filename.
  for (const [alias, target] of Object.entries(FILE_ALIASES)) {
    const normalized = fold(alias);
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9_.-])${escaped}([^a-z0-9_.-]|$)`, 'i').test(q)) return target;
  }
  return null;
}

function explicitFileLikeToken(question: string): string | null {
  const match = question.match(/\b[A-Za-z0-9_.-]+\.(?:xml|json|map|cfg|c)\b/i);
  return match?.[0] ?? null;
}

function mapsContainingFile(path: string): Dayz129Map[] {
  const index = getDayz129Index();
  return (Object.keys(index.maps) as Dayz129Map[]).filter((map) => Boolean(index.maps[map].files[path]));
}

function describeStructure(file: IndexedFile): string {
  const s = file.structure;
  if (s.root) {
    const top = Object.entries(s.topLevelTags ?? {}).slice(0, 6).map(([k, v]) => `${k}=${v}`).join(', ');
    return `XML-Root: \`${s.root}\`${top ? `; direkte Elemente: ${top}` : ''}.`;
  }
  if (s.rootType) {
    const keys = Object.keys(s.keyPaths ?? {}).slice(0, 8).join(', ');
    return `JSON-Root: ${s.rootType}${keys ? `; belegte Key-Pfade u. a.: ${keys}` : ''}.`;
  }
  return `Format: ${s.format ?? 'nicht textuell ausgewertet'}.`;
}

function fileExample(path: string): string | null {
  switch (path.toLowerCase()) {
    case 'db/types.xml':
      return [
        '**Beispiel aus deinen 1.29-`types.xml`: `WoodenPlank`**',
        '- Chernarus/Livonia/Sakhal: `nominal=0`, `min=0`, `lifetime=14400`, `restock=0`, `crafted=1`.',
        '- Das zeigt zugleich, warum `nominal` nicht pauschal als "maximale Menge" erklaert werden darf: ein craftbarer Typ kann mit `nominal=0` trotzdem ein realer DayZ-Classname sein.',
      ].join('\n');
    case 'db/events.xml':
      return [
        '**Beispiel aus Chernarus 1.29: `StaticHeliCrash`**',
        '`nominal=3`, `min=0`, `max=0`, `lifetime=2100`, `restock=0`, `position=fixed`, `limit=child`, `active=1`; als Child ist unter anderem `Wreck_UH1Y` mit `lootmin=10`, `lootmax=15`, `min=1`, `max=3` eingetragen.',
      ].join('\n');
    case 'db/messages.xml':
      return [
        '**Beispiel, das direkt als Kommentar in den gelieferten Chernarus-/Livonia-Dateien steht:**',
        '```xml',
        '<message>',
        '  <repeat>15</repeat>',
        "  <text>You're playing on my server (#name). Thank you .)</text>",
        '</message>',
        '```',
        'Ein weiteres belegtes Beispiel kombiniert `delay`, `repeat` und `onconnect`; ein Shutdown-Countdown verwendet `deadline`, `shutdown` und `#tmin`.',
      ].join('\n');
    case 'db/globals.xml':
      return 'Beispiel: `FlagRefreshFrequency`, `ZombieMaxCount` und `AnimalMaxCount` sind reale globale Variablen in den gelieferten 1.29-Dateien. Konkrete Werte werden nur aus der jeweiligen Datei/Karte genannt.';
    case 'cfgspawnabletypes.xml':
      return 'Beispiel: Ein `<type name="...">` kann `<attachments>` und `<cargo>` mit Wahrscheinlichkeiten enthalten oder ein Preset referenzieren. V-Bot nennt konkrete Typ-/Presetnamen nur, wenn sie im Index belegt sind.';
    case 'cfgeventspawns.xml':
      return 'Beispiel: Eventdefinitionen enthalten zu einem realen Eventnamen Positions-/Zoneneintraege. Die genaue Anzahl unterscheidet sich stark zwischen Chernarus, Livonia und Sakhal.';
    case 'cfggameplay.json':
      return 'Beispiel: `BaseBuildingData.HologramData.disableIsCollidingBBoxCheck` ist in allen drei gelieferten Dateien belegt. `true` deaktiviert diese konkrete Platzierungspruefung; `enableCfgGameplayFile = 1;` in der aktiven Server-Konfiguration aktiviert die Nutzung der Gameplay-Datei.';
    default:
      return null;
  }
}

function formatFileAnswer(path: string): DayzCatalogAnswer {
  const index = getDayz129Index();
  const maps = mapsContainingFile(path);
  const lines = [
    `**\`${path}\`** ${purposeFor(path)}`,
    '',
    `**Vorkommen in deinen 1.29-Datensaetzen:** ${maps.map((m) => MAP_LABELS[m]).join(', ') || 'keiner'}.`,
  ];
  for (const map of maps) {
    const file = index.maps[map].files[path];
    lines.push(`- ${MAP_LABELS[map]}: ${describeStructure(file)}`);
  }
  if (path.toLowerCase() === 'db/messages.xml' && !maps.includes('sakhal')) {
    lines.push('- Sakhal: `db/messages.xml` ist in deinem gelieferten Sakhal-Datensatz **nicht vorhanden**. Daraus darf nicht abgeleitet werden, dass jede Vanilla-Mission diese Datei zwingend enthalten muss.');
  }
  const example = fileExample(path);
  if (example) lines.push('', example);
  lines.push('', 'Quelle fuer Namen/Struktur/Werte: deine drei gelieferten DayZ-1.29-Datensaetze. Bedeutungen werden nur soweit erklaert, wie sie durch Dateiinhalt bzw. Bohemia-Dokumentation belegt sind.');
  return { answer: lines.join('\n'), topic: 'file', ids: [`dayz129:file:${path}`] };
}

export const TYPE_SYNONYMS: Record<string, string[]> = {
  'nagel': ['nail'], 'naegel': ['nail'], 'nagelbox': ['nail', 'box'], 'naegelbox': ['nail', 'box'],
  'holzbrett': ['wooden', 'plank'], 'holzbretter': ['wooden', 'plank'], 'brett': ['plank'], 'bretter': ['plank'],
  'wasserflasche': ['water', 'bottle'], 'flasche': ['bottle'],
  'metallplatte': ['metal', 'plate'], 'blech': ['metal', 'plate'],
  'kabeltrommel': ['cable', 'reel'], 'seekiste': ['sea', 'chest'],
  'autozelt': ['car', 'tent'], 'zelt': ['tent'], 'streichholz': ['match'], 'streichhoelzer': ['match'],
  'messer': ['knife'], 'axt': ['axe'], 'schaufel': ['shovel'], 'seil': ['rope'], 'fass': ['barrel'],
  'pistole': ['pistol'], 'magazin': ['mag'], 'munition': ['ammo'],
  'apfel': ['apple'], 'aepfel': ['apple'], 'birne': ['pear'], 'birnen': ['pear'],
  'pflaume': ['plum'], 'pflaumen': ['plum'], 'tomate': ['tomato'], 'tomaten': ['tomato'],
  'reis': ['rice'], 'kartoffel': ['potato'], 'kartoffeln': ['potato'],
};

/**
 * Kanonische Alias-Tabelle: ein deutsches/umgangssprachliches Wort steht fuer
 * GENAU einen realen Classname (nicht nur einen Score-Token wie TYPE_SYNONYMS).
 * Frueher pflegten dayz129CatalogPriority.ts (V1) und dayz129CatalogPriorityV3.ts
 * je eine eigene, unterschiedlich vollstaendige Kopie dieser Liste - ein Wort
 * konnte dadurch in der einen Ebene bekannt sein und in einer anderen nicht.
 * Jetzt gibt es nur noch diese eine Quelle.
 */
export const EXACT_ALIASES: Readonly<Record<string, string>> = {
  m4: 'M4A1',
  tundra: 'Winchester70',
  winchester: 'Winchester70',
  kampfstiefel: 'CombatBoots',
  combatboots: 'CombatBoots',
  kampfanzugshose: 'TTSKOPants',
  kampfanzughose: 'TTSKOPants',
  kampfhose: 'TTSKOPants',
  combatpants: 'TTSKOPants',
  bduhose: 'BDUPants',
  bdupants: 'BDUPants',
  feldrucksack: 'AliceBag',
  feldrucksaecke: 'AliceBag',
  alicebag: 'AliceBag',
  seekiste: 'SeaChest',
  seekisten: 'SeaChest',
  seachest: 'SeaChest',
  generator: 'PowerGenerator',
  generatoren: 'PowerGenerator',
  stromgenerator: 'PowerGenerator',
  stromgeneratoren: 'PowerGenerator',
  powergenerator: 'PowerGenerator',
  militaerzelt: 'LargeTent',
  militaerzelte: 'LargeTent',
  militarytent: 'LargeTent',
  largetent: 'LargeTent',
};

/**
 * Kanonische Farbwort-Tabelle fuer Farbvarianten-Aufloesung (z. B.
 * "Feldrucksack in Gruen" -> AliceBag_Green). Frueher hatten V2 und V3 je eine
 * eigene, unterschiedlich vollstaendige Kopie (V2 kannte z. B. kein "rot").
 */
export const COLOR_SUFFIXES = new Set([
  'black', 'blue', 'brown', 'green', 'grey', 'gray', 'red', 'orange', 'yellow', 'pink', 'white',
  'beige', 'olive', 'tan', 'khaki', 'camo', 'dpm', 'flecktarn', 'ttsko',
]);

export const COLOR_WORDS: ReadonlyArray<{ re: RegExp; suffixes: string[] }> = [
  { re: /\b(?:gruen|green)\b/i, suffixes: ['green'] },
  { re: /\b(?:schwarz|black)\b/i, suffixes: ['black'] },
  { re: /\b(?:braun|brown)\b/i, suffixes: ['brown'] },
  { re: /\b(?:grau|grey|gray)\b/i, suffixes: ['grey', 'gray'] },
  { re: /\b(?:blau|blue)\b/i, suffixes: ['blue'] },
  { re: /\b(?:rot|red)\b/i, suffixes: ['red'] },
  { re: /\b(?:orange)\b/i, suffixes: ['orange'] },
  { re: /\b(?:gelb|yellow)\b/i, suffixes: ['yellow'] },
  { re: /\b(?:rosa|pink)\b/i, suffixes: ['pink'] },
  { re: /\b(?:weiss|white)\b/i, suffixes: ['white'] },
  { re: /\bbeige\b/i, suffixes: ['beige'] },
  { re: /\b(?:oliv|olive)\b/i, suffixes: ['olive'] },
  { re: /\b(?:khaki|tan)\b/i, suffixes: ['khaki', 'tan'] },
  { re: /\b(?:camo|tarn|tarnung)\b/i, suffixes: ['camo', 'dpm', 'flecktarn', 'ttsko'] },
];

const TYPE_QUERY_EXCLUSIONS: Record<string, string[]> = {
  'holzbrett': ['PileOfWoodenPlanks'],
  'holzbretter': ['PileOfWoodenPlanks'],
  'brett': ['PileOfWoodenPlanks'],
  'bretter': ['PileOfWoodenPlanks'],
};

function queryTokens(question: string, synonyms: Record<string, string[]>): string[] {
  const raw = fold(question).split(/[^a-z0-9]+/).filter(Boolean);
  const out = new Set(raw);
  for (const token of raw) for (const extra of synonyms[token] ?? []) out.add(extra);
  return [...out];
}

function candidateScore(name: string, query: string, tokens: string[]): number {
  const nameCompact = compact(name);
  const qCompact = compact(query);
  if (nameCompact === qCompact) return 1000;
  if (qCompact.length >= 4 && nameCompact === qCompact.replace(/^(classname|class|typename|type)/, '')) return 950;
  // Einbuchstaben-Segmente aus Classnames (z. B. das abschliessende "K" in
  // MP5K) sind keine belastbaren Suchmerkmale. Sonst matcht jede deutsche
  // Bezeichnung mit K als Prefix auf MP5K und wird als angeblich eindeutiger
  // Classname ausgegeben.
  const nameTokens = splitIdentifier(name).filter((token) => token.length >= 3);
  let score = 0;
  for (const token of tokens) {
    if (token.length < 2) continue;
    if (nameTokens.includes(token)) score += 12;
    else if (nameTokens.some((n) => n.startsWith(token) || token.startsWith(n))) score += 6;
    else if (nameCompact.includes(token)) score += 3;
  }
  if (tokens.length && tokens.every((t) => t.length < 2 || nameCompact.includes(t) || nameTokens.includes(t))) score += 10;
  return score;
}

function findExactIndexedName(question: string, names: string[], lookup: Map<string, string>): string | null {
  const q = fold(question);
  const sorted = [...names].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    const lower = fold(name);
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(q)) return lookup.get(name.toLocaleLowerCase('de-DE')) ?? name;
  }
  return null;
}

export function searchDayz129Types(query: string, limit = 5): string[] {
  const index = getDayz129Index();
  const rawTokens = fold(query).split(/[^a-z0-9]+/).filter(Boolean);
  const excluded = new Set(rawTokens.flatMap((token) => TYPE_QUERY_EXCLUSIONS[token] ?? []));
  const tokens = queryTokens(query, TYPE_SYNONYMS).filter((t) => !['class', 'classname', 'typename', 'type', 'item', 'gegenstand', 'dayz', 'heisst', 'heißt', 'wie', 'ist', 'der', 'die', 'das'].includes(t));
  return index.allTypeNames
    .filter((name) => !excluded.has(name))
    .map((name) => ({ name, score: candidateScore(name, query, tokens) }))
    .filter((x) => x.score >= 6)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit).map((x) => x.name);
}

function formatRecord(record: Record<string, RecordValue>): string {
  const ordered = ['nominal', 'min', 'max', 'lifetime', 'restock', 'quantmin', 'quantmax', 'cost', 'position', 'limit', 'active', 'secondary'];
  const parts: string[] = [];
  for (const key of ordered) if (record[key] !== undefined) parts.push(`\`${key}=${String(record[key])}\``);
  for (const key of ['category', 'usage', 'value', 'tag']) {
    const value = record[key];
    if (Array.isArray(value) && value.length) parts.push(`\`${key}=${value.join('+')}\``);
  }
  if (record.flags && !Array.isArray(record.flags) && typeof record.flags === 'object') {
    const flags = Object.entries(record.flags as Record<string, Scalar>).map(([k, v]) => `${k}=${v}`).join(', ');
    parts.push(`flags: ${flags}`);
  }
  return parts.join(', ');
}

function formatTypeAnswer(name: string, requestedMaps: Dayz129Map[] = []): DayzCatalogAnswer {
  const index = getDayz129Index();
  const lines = [`**DayZ-Classname: \`${name}\`**`, ''];
  let found = false;
  const maps = requestedMaps.length ? requestedMaps : (Object.keys(index.maps) as Dayz129Map[]);
  for (const map of maps) {
    const record = index.maps[map].types[name];
    if (!record) continue;
    found = true;
    lines.push(`- **${MAP_LABELS[map]}:** ${formatRecord(record)}`);
  }
  if (!found) lines.push('Der Name ist im globalen Index vorhanden, aber in keiner Map-Detailtabelle aufloesbar; das ist ein Indexfehler und wird nicht durch Raten ersetzt.');
  lines.push('', 'Die Werte oben stammen direkt aus deinen drei `types.xml`-Dateien. Kartenwerte werden getrennt gehalten und nicht zu einem erfundenen Universalwert zusammengezogen.');
  return { answer: lines.join('\n'), topic: 'type', ids: [`dayz129:type:${name}`] };
}

export const EVENT_SYNONYMS: Record<string, string[]> = {
  'heli': ['heli', 'crash'], 'helikopter': ['heli', 'crash'], 'helikopterabsturz': ['heli', 'crash'],
  'zombie': ['infected'], 'zombies': ['infected'], 'infizierte': ['infected'],
  'wolf': ['wolf'], 'woelfe': ['wolf'], 'baer': ['bear'], 'bär': ['bear'], 'reh': ['deer'], 'rentier': ['reindeer'],
  'polizei': ['police'], 'militaer': ['military'], 'militär': ['military'], 'konvoi': ['convoy'],
  'weihnachten': ['christmas'], 'weihnachtsbaum': ['christmas', 'tree'], 'santa': ['santa'],
  'auto': ['vehicle'], 'fahrzeug': ['vehicle'], 'boot': ['boat'], 'zug': ['train'], 'flugzeug': ['airplane'],
};

export function searchDayz129Events(query: string, limit = 5): string[] {
  const index = getDayz129Index();
  const tokens = queryTokens(query, EVENT_SYNONYMS).filter((t) => !['event', 'eventname', 'name', 'dayz', 'wie', 'heisst', 'heißt', 'der', 'die', 'das'].includes(t));
  const direct = index.allEventNames
    .map((name) => ({ name, score: candidateScore(name, query, tokens) }))
    .filter((x) => x.score >= 6);

  // Also find events by a real child classname.
  for (const map of Object.keys(index.maps) as Dayz129Map[]) {
    for (const [eventName, event] of Object.entries(index.maps[map].events)) {
      const children = event.children;
      if (!Array.isArray(children)) continue;
      for (const child of children as Record<string, Scalar>[]) {
        const type = typeof child.type === 'string' ? child.type : '';
        if (type && compact(query).includes(compact(type))) direct.push({ name: eventName, score: 80 });
      }
    }
  }

  return [...new Map(direct.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).map((x) => [x.name, x])).values()]
    .slice(0, limit).map((x) => x.name);
}

function formatEventAnswer(name: string, requestedMaps: Dayz129Map[] = []): DayzCatalogAnswer {
  const index = getDayz129Index();
  const lines = [`**DayZ-Event: \`${name}\`**`, ''];
  const maps = requestedMaps.length ? requestedMaps : (Object.keys(index.maps) as Dayz129Map[]);
  for (const map of maps) {
    const record = index.maps[map].events[name];
    if (!record) {
      lines.push(`- **${MAP_LABELS[map]}:** in deiner 1.29-\`events.xml\` nicht vorhanden.`);
      continue;
    }
    lines.push(`- **${MAP_LABELS[map]}:** ${formatRecord(record)}`);
    const children = record.children;
    if (Array.isArray(children) && children.length) {
      const shown = (children as Record<string, Scalar>[]).slice(0, 8).map((child) => {
        const type = child.type ? String(child.type) : '?';
        const rest = Object.entries(child).filter(([k]) => k !== 'type').map(([k, v]) => `${k}=${v}`).join(', ');
        return `\`${type}\`${rest ? ` (${rest})` : ''}`;
      });
      lines.push(`  Children: ${shown.join(', ')}${children.length > shown.length ? ` … +${children.length - shown.length} weitere` : ''}`);
    }
  }
  lines.push('', 'Alle Namen und Werte stammen direkt aus deinen drei 1.29-`events.xml`-Dateien. Fehlt ein Event auf einer Karte, wird es dort nicht hinzuerfunden.');
  return { answer: lines.join('\n'), topic: 'event', ids: [`dayz129:event:${name}`] };
}

/**
 * Prueft, ob die Frage ein Wort enthaelt, das in der kanonischen Alias- oder
 * Synonym-Tabelle als bekanntes Item-Wort gefuehrt wird. Dadurch bleibt dieses
 * Gate automatisch mit TYPE_SYNONYMS/EXACT_ALIASES synchron, statt eine dritte,
 * unabhaengig gepflegte Wortliste zu sein, die bei jeder Erweiterung der
 * Tabellen erneut von Hand nachgezogen werden muesste (genau das hat den
 * "Apfel"-Bug verursacht: das Wort war der Such-Engine laengst bekannt, aber
 * nicht diesem Gate).
 */
function containsKnownItemWord(question: string): boolean {
  const words = new Set(fold(question).split(/[^a-z0-9]+/).filter(Boolean));
  for (const key of Object.keys(TYPE_SYNONYMS)) if (words.has(key)) return true;
  for (const key of Object.keys(EXACT_ALIASES)) if (words.has(key)) return true;
  return false;
}

function isTypeLookupIntent(question: string): boolean {
  const q = fold(question);
  return /\b(class|classname|class name|typename|type name|itemname|item name)\b/.test(q)
    || /wie\s+(heisst|heißt).*\b(item|gegenstand|class|classname)\b/.test(q)
    || containsKnownItemWord(question);
}

function isEventLookupIntent(question: string): boolean {
  const q = fold(question);
  return /\bevent(name)?\b/.test(q) || /\b(helikopterabsturz|heli\s*crash|zombie\s*event|militaer.*konvoi|militär.*konvoi)\b/.test(q);
}

function candidateListAnswer(kind: 'type' | 'event', candidates: string[]): DayzCatalogAnswer {
  const title = kind === 'type' ? 'Classname' : 'Eventname';
  const source = kind === 'type' ? '`types.xml`' : '`events.xml`';
  return {
    answer: [
      `Ich finde mehrere **reale 1.29-${title}-Kandidaten** in deinen drei Dateien:`,
      ...candidates.map((name) => `- \`${name}\``),
      '',
      `Sag mir, welchen du meinst; ich gebe dann die kartenspezifischen Werte aus ${source} aus. Ich erfinde keinen Namen ausserhalb dieses Index.`,
    ].join('\n'),
    topic: kind === 'type' ? 'type-search' : 'event-search',
    ids: candidates.map((name) => `dayz129:${kind}:${name}`),
  };
}

export function answerDayz129CatalogQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const index = getDayz129Index();
  const q = fold(question);
  const requestedMaps = detectMaps(question);

  const path = canonicalFileFromText(question);
  if (path) return formatFileAnswer(path);

  const explicitFile = explicitFileLikeToken(question);
  if (explicitFile && /\b(dayz|server|mission|datei|file|xml|json|ce|central economy)\b/i.test(question)) {
    return {
      answer: `Die Datei **\`${explicitFile}\`** kommt in keinem deiner drei gelieferten DayZ-1.29-Datensaetze (Chernarus, Livonia, Sakhal) vor. Deshalb erfinde ich weder Pfad noch Funktion dafuer. Wenn es eine Mod-Datei ist, brauche ich die zugehoerige Mod-/Dateiquelle.`,
      topic: 'unknown-file', ids: [`dayz129:unknown-file:${explicitFile}`],
    };
  }

  const exactType = findExactIndexedName(question, index.allTypeNames, typeByLower!);
  if (exactType && (isTypeLookupIntent(question) || q.includes(fold(exactType)))) return formatTypeAnswer(exactType, requestedMaps);

  if (isTypeLookupIntent(question)) {
    const candidates = searchDayz129Types(question, 5);
    if (candidates.length === 1) return formatTypeAnswer(candidates[0], requestedMaps);
    if (candidates.length > 1) {
      const top = searchDayz129Types(question, 2);
      const exactNatural = ['holzbretter', 'holzbrett', 'nagelbox', 'naegelbox', 'wasserflasche', 'metallplatte', 'kabeltrommel', 'seekiste', 'autozelt'].some((x) => fold(question).includes(x));
      if (exactNatural && top[0]) return formatTypeAnswer(top[0], requestedMaps);
      return candidateListAnswer('type', candidates);
    }
    return {
      answer: 'Dazu finde ich **keinen passenden Classname** unter den 1.974 realen Classnames aus deinen drei 1.29-`types.xml`-Dateien. Ich rate keinen Namen. Beschreibe den Gegenstand etwas genauer.',
      topic: 'type-search', ids: ['dayz129:type:not-found'],
    };
  }

  const exactEvent = findExactIndexedName(question, index.allEventNames, eventByLower!);
  if (exactEvent && (isEventLookupIntent(question) || q.includes(fold(exactEvent)))) return formatEventAnswer(exactEvent, requestedMaps);

  if (isEventLookupIntent(question)) {
    const candidates = searchDayz129Events(question, 5);
    if (candidates.length === 1) return formatEventAnswer(candidates[0], requestedMaps);
    if (candidates.length > 1) {
      const strongNatural = /helikopterabsturz|heli\s*crash|militaer.*konvoi|militär.*konvoi/.test(fold(question));
      if (strongNatural) return formatEventAnswer(candidates[0], requestedMaps);
      return candidateListAnswer('event', candidates);
    }
    return {
      answer: 'Dazu finde ich **keinen passenden Eventnamen** unter den 72 realen Eventnamen aus deinen drei 1.29-`events.xml`-Dateien. Ich rate keinen Eventnamen.',
      topic: 'event-search', ids: ['dayz129:event:not-found'],
    };
  }

  return null;
}

export function isKnownDayz129Identifier(identifier: string): boolean {
  if (!identifier) return false;
  const index = getDayz129Index();
  const c = compact(identifier);
  if (index.allTypeNames.some((name) => compact(name) === c)) return true;
  if (index.allEventNames.some((name) => compact(name) === c)) return true;
  if (index.allRelativePaths.some((path) => compact(path) === c || compact(path.split('/').pop()!) === c)) return true;
  return false;
}

export function enrichDayz129FollowUp(question: string, previousAssistantText?: string | null): string {
  if (!question || !previousAssistantText) return question;
  const q = fold(question).trim();
  if (q.length > 160 || !/(beispiel|wie genau|warum|was bedeutet|kannst du|zeig|und wie|und was|und auf|auf chernarus|auf livonia|auf sakhal|nochmal|dazu|welcher wert|welche werte)/i.test(q)) return question;
  const path = canonicalFileFromText(previousAssistantText);
  if (path) return `${path}: ${question}`;

  const index = getDayz129Index();
  const type = findExactIndexedName(previousAssistantText, index.allTypeNames, typeByLower!);
  if (type) return `Classname ${type}: ${question}`;
  const event = findExactIndexedName(previousAssistantText, index.allEventNames, eventByLower!);
  if (event) return `Event ${event}: ${question}`;
  return question;
}

export function getDayz129CatalogStats(): { types: number; events: number; paths: number } {
  const index = getDayz129Index();
  return { types: index.allTypeNames.length, events: index.allEventNames.length, paths: index.allRelativePaths.length };
}

/**
 * Der generierte Index speichert fuer JEDE der 42 Dateien pro Karte eine
 * strukturelle Zusammenfassung (Element-/Attribut-Anzahlen fuer XML,
 * Key-Pfade fuer JSON) - nicht nur fuer types.xml/events.xml. Diese Zaehlwerte
 * lagen bisher ungenutzt im Index; "wie viele Zombie-Zonen hat Sakhal?" war
 * damit unbeantwortbar, obwohl `env/zombie_territories.xml`s Struktur die
 * Antwort (417) bereits exakt enthaelt. Dieser Pfad macht diese bereits
 * indexierten, aber ungenutzten Zaehlwerte fuer ganz konkrete, eng gefasste
 * Fragekategorien nutzbar - bewusst nur fuer Kategorien mit einem eindeutigen,
 * belegten Element-Namen; bei fehlendem Zaehlwert wird nichts geraten.
 */
interface StructuralCountCategory {
  file: string;
  countKey: string;
  label: string;
  words: RegExp;
}

const TERRITORY_COUNT_CATEGORIES: readonly StructuralCountCategory[] = [
  { file: 'env/bear_territories.xml', countKey: 'zone', label: 'Bär-Territorien (env/bear_territories.xml)', words: /\b(?:baeren?|bären?)\b/i },
  { file: 'env/cattle_territories.xml', countKey: 'zone', label: 'Rind-Territorien (env/cattle_territories.xml)', words: /\b(?:rind(?:er)?|kuh|kuehe|kühe)\b/i },
  { file: 'env/domestic_animals_territories.xml', countKey: 'zone', label: 'Haustier-Territorien (env/domestic_animals_territories.xml)', words: /\bhaustiere?\b/i },
  { file: 'env/fox_territories.xml', countKey: 'zone', label: 'Fuchs-Territorien (env/fox_territories.xml)', words: /\b(?:fuchs|fuechse|füchse)\b/i },
  { file: 'env/hare_territories.xml', countKey: 'zone', label: 'Hase-Territorien (env/hare_territories.xml)', words: /\bhasen?\b/i },
  { file: 'env/hen_territories.xml', countKey: 'zone', label: 'Huhn-Territorien (env/hen_territories.xml)', words: /\b(?:huhn|huehner|hühner|hennen?)\b/i },
  { file: 'env/pig_territories.xml', countKey: 'zone', label: 'Schwein-Territorien (env/pig_territories.xml)', words: /\bschweine?\b/i },
  { file: 'env/red_deer_territories.xml', countKey: 'zone', label: 'Rothirsch-Territorien (env/red_deer_territories.xml)', words: /\b(?:rothirsche?|rotwild)\b/i },
  { file: 'env/roe_deer_territories.xml', countKey: 'zone', label: 'Reh-Territorien (env/roe_deer_territories.xml)', words: /\brehe?\b/i },
  { file: 'env/sheep_goat_territories.xml', countKey: 'zone', label: 'Schaf-/Ziegen-Territorien (env/sheep_goat_territories.xml)', words: /\b(?:schafe?|ziegen?)\b/i },
  { file: 'env/wild_boar_territories.xml', countKey: 'zone', label: 'Wildschwein-Territorien (env/wild_boar_territories.xml)', words: /\bwildschweine?\b/i },
  { file: 'env/wolf_territories.xml', countKey: 'zone', label: 'Wolf-Territorien (env/wolf_territories.xml)', words: /\b(?:woelfe|wölfe|wolfe?s?)\b/i },
  { file: 'env/zombie_territories.xml', countKey: 'zone', label: 'Zombie-/Infizierten-Territorien (env/zombie_territories.xml)', words: /\b(?:zombies?|infizierten?)\b/i },
];

const OTHER_STRUCTURAL_COUNT_CATEGORIES: readonly StructuralCountCategory[] = [
  { file: 'cfgeventspawns.xml', countKey: 'event', label: 'Event-Definitionen (cfgeventspawns.xml)', words: /\bevent[-\s]?definition(?:en)?\b/i },
  { file: 'cfgeventspawns.xml', countKey: 'pos', label: 'Event-Positionen (cfgeventspawns.xml)', words: /\bevent[-\s]?position(?:en)?\b/i },
  { file: 'cfgeventspawns.xml', countKey: 'zone', label: 'Event-Zonen (cfgeventspawns.xml)', words: /\bevent[-\s]?zonen?\b/i },
  { file: 'mapgrouppos.xml', countKey: 'group', label: 'Mapgroups (mapgrouppos.xml)', words: /\bmapgroups?\b/i },
  { file: 'cfgplayerspawnpoints.xml', countKey: 'pos', label: 'Spawn-Punkte (cfgplayerspawnpoints.xml)', words: /\bspawn[-\s]?punkte?\b|\bspawnpoints?\b/i },
];

const STRUCTURAL_COUNT_CATEGORIES: readonly StructuralCountCategory[] = [
  ...TERRITORY_COUNT_CATEGORIES,
  ...OTHER_STRUCTURAL_COUNT_CATEGORIES,
];

const COUNT_QUESTION_RE = /\b(?:wie\s+viele?|anzahl)\b/i;

function detectStructuralCountCategory(question: string): StructuralCountCategory | null {
  if (!COUNT_QUESTION_RE.test(question)) return null;
  return STRUCTURAL_COUNT_CATEGORIES.find((cat) => cat.words.test(question)) ?? null;
}

export function answerStructuralCountQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const category = detectStructuralCountCategory(question);
  if (!category) return null;

  const index = getDayz129Index();
  const requestedMaps = detectMaps(question);
  const maps: Dayz129Map[] = requestedMaps.length ? requestedMaps : ['chernarus', 'livonia', 'sakhal'];

  const lines = [`**${category.label}**`, ''];
  let found = false;
  for (const map of maps) {
    const file = index.maps[map]?.files[category.file];
    if (!file) {
      lines.push(`- ${MAP_LABELS[map]}: Datei in deinem gelieferten Datensatz nicht vorhanden.`);
      continue;
    }
    const count = file.structure.elementCounts?.[category.countKey];
    if (typeof count !== 'number') {
      lines.push(`- ${MAP_LABELS[map]}: kein auswertbarer Zaehlwert in der indexierten Dateistruktur.`);
      continue;
    }
    found = true;
    lines.push(`- ${MAP_LABELS[map]}: ${count}`);
  }
  // Fail-closed: ohne mindestens einen echten Zaehlwert wird keine hohle
  // Antwort ausgegeben, die Frage bleibt unbeantwortet statt geraten.
  if (!found) return null;

  lines.push(
    '',
    `Quelle: Element-Anzahl \`${category.countKey}\` aus der indexierten Struktur von \`${category.file}\` deiner drei 1.29-Datensaetze (strukturell ausgewertet, kein erfundener Wert).`,
  );
  return {
    answer: lines.join('\n'),
    topic: 'file',
    ids: maps.map((map) => `dayz129:structure:${map}:${category.file}:${category.countKey}`),
  };
}

// ============================================================================
// Phase B: Antworten auf Basis der jetzt vollstaendig geparsten Nicht-types/
// events-Dateien (globals.xml, economy.xml, cfgeconomycore.xml, cfgweather.xml,
// cfglimitsdefinition(user).xml, cfgignorelist.xml, env/*_territories.xml,
// cfgeventgroups.xml, cfgrandompresets.xml, cfgeffectarea.json,
// cfgspawnabletypes.xml). Jede Funktion bleibt strikt fail-closed: ohne einen
// im Index tatsaechlich vorhandenen Namen/Bezug wird nichts geraten.
// ============================================================================

/** Laengster, tatsaechlich als eigenes Wort/Substring vorkommender bekannter Schluessel (>=5 Zeichen, um triviale Kurzwort-Kollisionen zu vermeiden). */
function findMentionedKey(question: string, keys: Iterable<string>): string | null {
  const q = fold(question);
  let best: string | null = null;
  for (const key of keys) {
    if (key.length < 5) continue;
    const k = fold(key);
    const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(q) && (!best || key.length > best.length)) {
      best = key;
    }
  }
  return best;
}

function formatScalarRecord(rec: Record<string, Scalar>): string {
  return Object.entries(rec).map(([k, v]) => `\`${k}=${v}\``).join(', ');
}

export function answerGlobalVariableQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const index = getDayz129Index();
  const allNames = new Set<string>();
  for (const map of Object.keys(index.maps) as Dayz129Map[]) {
    for (const name of Object.keys(index.maps[map].globals ?? {})) allNames.add(name);
  }
  const name = findMentionedKey(question, allNames);
  if (!name) return null;

  const requestedMaps = detectMaps(question);
  const maps: Dayz129Map[] = requestedMaps.length ? requestedMaps : ['chernarus', 'livonia', 'sakhal'];
  const lines = [`**Globale CE-Variable \`${name}\` (db/globals.xml)**`, ''];
  let found = false;
  for (const map of maps) {
    const entry = index.maps[map]?.globals?.[name];
    if (!entry) { lines.push(`- ${MAP_LABELS[map]}: nicht vorhanden.`); continue; }
    found = true;
    lines.push(`- ${MAP_LABELS[map]}: \`${name}=${entry.value}\``);
  }
  if (!found) return null;
  lines.push('', 'Quelle: `db/globals.xml` deiner drei 1.29-Datensaetze.');
  return { answer: lines.join('\n'), topic: 'file', ids: maps.map((m) => `dayz129:globals:${m}:${name}`) };
}

// Die staerker DayZ-spezifischen Verbindungen ("usage-flags", "wertstufen",
// "central economy" + kategorien/tags) loesen allein aus. Die alleinstehenden
// generischen Woerter "kategorien"/"tags"/"categories" sind absichtlich NICHT
// allein ausreichend (z.B. "wie viele Kategorien hat mein Kuehlschrank?")
// und brauchen zusaetzlich einen DayZ-/CE-Kontext im selben Satz.
const LIMITS_DEFINITION_SPECIFIC_RE = /\b(usage[-\s]?(?:flags?|zonen?)|wertstufen?|value[-\s]?flags?|tier[-\s]?flags?)\b/i;
const LIMITS_DEFINITION_GENERIC_RE = /\b(kategorien?|categor(?:y|ies)|tags?)\b/i;
const LIMITS_DEFINITION_CONTEXT_RE = /\b(dayz|central economy|\bce\b|cfglimitsdefinition|types?\.xml|loot|classname)\b/i;

export function answerLimitsDefinitionQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const isSpecific = LIMITS_DEFINITION_SPECIFIC_RE.test(question);
  const isGenericWithContext = LIMITS_DEFINITION_GENERIC_RE.test(question) && LIMITS_DEFINITION_CONTEXT_RE.test(question);
  if (!isSpecific && !isGenericWithContext) return null;
  const index = getDayz129Index();
  const def = index.maps.chernarus?.limitsDefinition;
  if (!def) return null;
  const q = fold(question);
  let key: keyof typeof def | null = null;
  let label = '';
  if (/\bkategorien?|categor/i.test(q)) { key = 'categories'; label = 'Kategorien (`category`)'; }
  else if (/\btags?\b/i.test(q)) { key = 'tags'; label = 'Tags (`tag`)'; }
  else if (/\busage/i.test(q)) { key = 'usageflags'; label = 'Usage-Zonen (`usage`)'; }
  else if (/\bwertstufen?|value|tier/i.test(q)) { key = 'valueflags'; label = 'Wertstufen (`value`)'; }
  if (!key) return null;
  const names = def[key];
  return {
    answer: [
      `**Central-Economy-${label} - vollstaendige Liste aus \`cfglimitsdefinition.xml\`:**`,
      names.map((n) => `\`${n}\``).join(', '),
      '',
      'Diese Liste ist die verbindliche Namensmenge. Ein `usage`/`category`/`value`/`tag`-Wert in `types.xml`, der hier nicht auftaucht, ist nicht belegt.',
    ].join('\n'),
    topic: 'file',
    ids: [`dayz129:limitsDefinition:${key}`],
  };
}

// "ignore-list"/"ignorierliste" sind eigenstaendig eindeutig DayZ-CE-Fachbegriffe.
// Das bloße Verb "ignoriert" ist dagegen normale Alltagssprache ("hat mich
// ignoriert") und braucht deshalb zusaetzlich DayZ-/CE-Kontext oder einen
// bereits im Satz erkannten echten Classname.
const IGNORE_LIST_SPECIFIC_RE = /\bignore[-\s]?list|ignorierliste\b/i;
const IGNORE_LIST_VERB_RE = /\bignoriert\b/i;
const IGNORE_LIST_CONTEXT_RE = /\b(dayz|central economy|\bce\b|cfgignorelist|classname|types?\.xml)\b/i;

export function answerIgnoreListQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const hasExactType = !!findExactIndexedName(question, getDayz129Index().allTypeNames, typeByLower!);
  const isSpecific = IGNORE_LIST_SPECIFIC_RE.test(question);
  const isVerbWithContext = IGNORE_LIST_VERB_RE.test(question) && (IGNORE_LIST_CONTEXT_RE.test(question) || hasExactType);
  if (!isSpecific && !isVerbWithContext) return null;
  const index = getDayz129Index();
  const chernarusIgnore = index.maps.chernarus?.ignoreList;
  if (!chernarusIgnore) return null;

  const exact = findExactIndexedName(question, index.allTypeNames, typeByLower!);
  if (exact) {
    const requestedMaps = detectMaps(question);
    const maps: Dayz129Map[] = requestedMaps.length ? requestedMaps : ['chernarus', 'livonia', 'sakhal'];
    const lines = [`**Ist \`${exact}\` auf der CE-Ignore-Liste (cfgignorelist.xml)?**`, ''];
    for (const map of maps) {
      const onList = index.maps[map]?.ignoreList?.includes(exact) ?? false;
      lines.push(`- ${MAP_LABELS[map]}: ${onList ? 'ja' : 'nein'}`);
    }
    return { answer: lines.join('\n'), topic: 'file', ids: maps.map((m) => `dayz129:ignoreList:${m}:${exact}`) };
  }

  return {
    answer: [
      '**CE-Ignore-Liste (`cfgignorelist.xml`, Chernarus):**',
      chernarusIgnore.map((n) => `\`${n}\``).join(', '),
      '',
      'Diese Typen werden von der Central-Economy-Zaehlung ignoriert. Die Liste kann sich pro Karte leicht unterscheiden.',
    ].join('\n'),
    topic: 'file',
    ids: ['dayz129:ignoreList:chernarus'],
  };
}

// Zusammengesetzte/technische Begriffe sind allein eindeutig genug (kommen in
// normaler Alltagssprache praktisch nie vor). Die einzelnen deutschen
// Alltagswoerter dafuer ("regen", "nebel", "wolken", "schnee", "sturm",
// "gewitter", "blitz" ...) sind dagegen ganz normale Wetter-Vokabeln und
// brauchen zusaetzlich DayZ-Kontext, sonst wuerde z.B. "der Regen war stark"
// faelschlich eine cfgweather.xml-Antwort ausloesen.
const WEATHER_SECTION_WORDS_SPECIFIC: Readonly<Record<string, string>> = {
  windmagnitude: 'windMagnitude', windstaerke: 'windMagnitude',
  winddirection: 'windDirection', windrichtung: 'windDirection',
  cfgweather: 'storm',
};
const WEATHER_SECTION_WORDS_GENERIC: Readonly<Record<string, string>> = {
  overcast: 'overcast', bewoelkung: 'overcast', wolken: 'overcast',
  fog: 'fog', nebel: 'fog',
  rain: 'rain', regen: 'rain',
  snowfall: 'snowfall', schneefall: 'snowfall', schnee: 'snowfall',
  storm: 'storm', sturm: 'storm', gewitter: 'storm', blitz: 'storm',
};
const WEATHER_CONTEXT_RE = /\b(dayz|server|cfgweather|chernarus|livonia|sakhal|enoch|frostline)\b/i;

export function answerWeatherQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const words = fold(question).split(/[^a-z0-9]+/).filter(Boolean);
  let section: string | null = null;
  for (const w of words) if (WEATHER_SECTION_WORDS_SPECIFIC[w]) { section = WEATHER_SECTION_WORDS_SPECIFIC[w]; break; }
  if (!section && WEATHER_CONTEXT_RE.test(question)) {
    for (const w of words) if (WEATHER_SECTION_WORDS_GENERIC[w]) { section = WEATHER_SECTION_WORDS_GENERIC[w]; break; }
  }
  if (!section) return null;

  const index = getDayz129Index();
  const requestedMaps = detectMaps(question);
  const maps: Dayz129Map[] = requestedMaps.length ? requestedMaps : ['chernarus', 'livonia', 'sakhal'];
  const lines = [`**Wetter-Sektion \`${section}\` (cfgweather.xml)**`, ''];
  let found = false;
  for (const map of maps) {
    const block = index.maps[map]?.weather?.sections?.[section];
    if (!block) { lines.push(`- ${MAP_LABELS[map]}: nicht vorhanden.`); continue; }
    found = true;
    if (section === 'storm') {
      lines.push(`- ${MAP_LABELS[map]}: ${formatScalarRecord(block as unknown as Record<string, Scalar>)}`);
    } else {
      const parts = Object.entries(block).map(([sub, rec]) => `${sub}(${formatScalarRecord(rec)})`);
      lines.push(`- ${MAP_LABELS[map]}: ${parts.join('; ')}`);
    }
  }
  if (!found) return null;
  lines.push('', 'Quelle: `cfgweather.xml` deiner drei 1.29-Datensaetze.');
  return { answer: lines.join('\n'), topic: 'file', ids: maps.map((m) => `dayz129:weather:${m}:${section}`) };
}

export function answerEffectAreaQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const index = getDayz129Index();
  const allNames = new Set<string>();
  for (const map of Object.keys(index.maps) as Dayz129Map[]) {
    for (const area of index.maps[map].effectAreas?.areas ?? []) if (area.name) allNames.add(area.name);
  }
  const name = findMentionedKey(question, allNames);
  if (!name) return null;

  const requestedMaps = detectMaps(question);
  const maps: Dayz129Map[] = requestedMaps.length ? requestedMaps : ['chernarus', 'livonia', 'sakhal'];
  const lines = [`**Kontaminationsbereich \`${name}\` (cfgeffectarea.json)**`, ''];
  let found = false;
  for (const map of maps) {
    const area = index.maps[map]?.effectAreas?.areas.find((a) => a.name === name);
    if (!area) { lines.push(`- ${MAP_LABELS[map]}: nicht vorhanden.`); continue; }
    found = true;
    lines.push(`- ${MAP_LABELS[map]}: Typ \`${area.type}\`, Radius ${area.radius}, Trigger \`${area.triggerType}\``);
  }
  if (!found) return null;
  lines.push('', 'Quelle: `cfgeffectarea.json` deiner drei 1.29-Datensaetze.');
  return { answer: lines.join('\n'), topic: 'file', ids: maps.map((m) => `dayz129:effectArea:${m}:${name}`) };
}

export function answerRandomPresetQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const index = getDayz129Index();
  const allNames = new Set<string>();
  for (const map of Object.keys(index.maps) as Dayz129Map[]) {
    for (const name of Object.keys(index.maps[map].randomPresets ?? {})) allNames.add(name);
  }
  const name = findMentionedKey(question, allNames);
  if (!name) return null;

  const requestedMaps = detectMaps(question);
  const maps: Dayz129Map[] = requestedMaps.length ? requestedMaps : ['chernarus', 'livonia', 'sakhal'];
  const lines = [`**Random-Preset \`${name}\` (cfgrandompresets.xml)**`, ''];
  let found = false;
  for (const map of maps) {
    const preset = index.maps[map]?.randomPresets?.[name];
    if (!preset) { lines.push(`- ${MAP_LABELS[map]}: nicht vorhanden.`); continue; }
    found = true;
    const items = preset.items.map((i) => `\`${i.name}\`${i.chance != null ? ` (${i.chance})` : ''}`).join(', ');
    lines.push(`- ${MAP_LABELS[map]} (${preset.kind}, chance=${preset.chance}): ${items || 'keine Items'}`);
  }
  if (!found) return null;
  lines.push('', 'Quelle: `cfgrandompresets.xml` deiner drei 1.29-Datensaetze.');
  return { answer: lines.join('\n'), topic: 'file', ids: maps.map((m) => `dayz129:randomPreset:${m}:${name}`) };
}

export function answerEventGroupQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const index = getDayz129Index();
  const allNames = new Set<string>();
  for (const map of Object.keys(index.maps) as Dayz129Map[]) {
    for (const name of Object.keys(index.maps[map].eventGroups ?? {})) allNames.add(name);
  }
  const name = findMentionedKey(question, allNames);
  if (!name) return null;

  const requestedMaps = detectMaps(question);
  const maps: Dayz129Map[] = requestedMaps.length ? requestedMaps : ['chernarus', 'livonia', 'sakhal'];
  const lines = [`**Event-Gruppe \`${name}\` (cfgeventgroups.xml)**`, ''];
  let found = false;
  for (const map of maps) {
    const group = index.maps[map]?.eventGroups?.[name];
    if (!group) { lines.push(`- ${MAP_LABELS[map]}: nicht vorhanden.`); continue; }
    found = true;
    const children = Object.entries(group).map(([type, count]) => `\`${type}\`${count > 1 ? ` x${count}` : ''}`).join(', ');
    lines.push(`- ${MAP_LABELS[map]}: ${children}`);
  }
  if (!found) return null;
  lines.push('', 'Quelle: `cfgeventgroups.xml` deiner drei 1.29-Datensaetze.');
  return { answer: lines.join('\n'), topic: 'file', ids: maps.map((m) => `dayz129:eventGroup:${m}:${name}`) };
}

const SPAWNABLE_TYPE_CONTEXT_RE = /\b(zubehoer|zubehör|anhaenge|anhänge|attachment|cargo|spawnt|spawnable|beladung|ausstattung)\b/i;

export function answerSpawnableTypeQuestion(question: string): DayzCatalogAnswer | null {
  if (!question || !SPAWNABLE_TYPE_CONTEXT_RE.test(question)) return null;
  const index = getDayz129Index();
  const exact = findExactIndexedName(question, index.allTypeNames, typeByLower!);
  if (!exact) return null;

  const requestedMaps = detectMaps(question);
  const maps: Dayz129Map[] = requestedMaps.length ? requestedMaps : ['chernarus', 'livonia', 'sakhal'];
  const lines = [`**Spawn-Zubehoer/Cargo fuer \`${exact}\` (cfgspawnabletypes.xml)**`, ''];
  let found = false;
  for (const map of maps) {
    const entry = index.maps[map]?.spawnableTypes?.[exact];
    if (!entry) { lines.push(`- ${MAP_LABELS[map]}: keine cfgspawnabletypes.xml-Eintraege.`); continue; }
    found = true;
    const parts: string[] = [];
    if (entry.hoarder) parts.push('hoarder');
    for (const att of entry.attachments ?? []) {
      parts.push(`attachments(chance=${att.chance}): ${att.preset ? `preset \`${att.preset}\`` : (att.items ?? []).map((i) => `\`${i}\``).join(', ')}`);
    }
    for (const c of entry.cargo ?? []) {
      parts.push(`cargo(chance=${c.chance}): ${c.preset ? `preset \`${c.preset}\`` : (c.items ?? []).map((i) => `\`${i}\``).join(', ')}`);
    }
    lines.push(`- ${MAP_LABELS[map]}: ${parts.join(' | ') || 'keine weiteren Angaben'}`);
  }
  if (!found) return null;
  lines.push('', 'Quelle: `cfgspawnabletypes.xml` deiner drei 1.29-Datensaetze.');
  return { answer: lines.join('\n'), topic: 'file', ids: maps.map((m) => `dayz129:spawnableType:${m}:${exact}`) };
}

/**
 * Buendelt alle Phase-B-Antwortpfade in einer festen, kollisionsarmen
 * Reihenfolge: name-basierte Lookups zuerst (Klassennamen-Kollisionen
 * zwischen Kategorien sind praktisch ausgeschlossen, da jede Kategorie ihre
 * eigene, im Index reale Namensmenge nutzt), Themen-basierte Listen danach.
 */
export function answerDayz129ExtendedDataQuestion(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  return answerGlobalVariableQuestion(question)
    ?? answerEffectAreaQuestion(question)
    ?? answerRandomPresetQuestion(question)
    ?? answerEventGroupQuestion(question)
    ?? answerSpawnableTypeQuestion(question)
    ?? answerLimitsDefinitionQuestion(question)
    ?? answerIgnoreListQuestion(question)
    ?? answerWeatherQuestion(question);
}
