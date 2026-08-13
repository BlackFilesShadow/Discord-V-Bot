import { gunzipSync } from 'node:zlib';
import { DAYZ129_INDEX_GZIP_BASE64 } from './generated/dayz129IndexData';

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

interface IndexedMap {
  mission: string;
  files: Record<string, IndexedFile>;
  types: Record<string, Record<string, RecordValue>>;
  events: Record<string, Record<string, RecordValue>>;
}

export interface Dayz129Index {
  version: string;
  sourceTag: string;
  verifiedAgainstUserManifest: boolean;
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

const MAP_LABELS: Record<Dayz129Map, string> = {
  chernarus: 'Chernarus',
  livonia: 'Livonia',
  sakhal: 'Sakhal',
};

export function getDayz129Index(): Dayz129Index {
  if (!cached) {
    const raw = gunzipSync(Buffer.from(DAYZ129_INDEX_GZIP_BASE64, 'base64')).toString('utf8');
    cached = JSON.parse(raw) as Dayz129Index;
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

  for (const [alias, target] of Object.entries(FILE_ALIASES)) {
    if (q.includes(alias)) return target;
  }

  const paths = [...index.allRelativePaths].sort((a, b) => b.length - a.length);
  for (const path of paths) {
    if (q.includes(fold(path))) return path;
  }
  for (const path of paths) {
    const basename = path.split('/').pop()!;
    if (q.includes(fold(basename))) return path;
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

const TYPE_SYNONYMS: Record<string, string[]> = {
  'nagel': ['nail'], 'naegel': ['nail'], 'nagelbox': ['nail', 'box'], 'naegelbox': ['nail', 'box'],
  'holzbrett': ['wooden', 'plank'], 'holzbretter': ['wooden', 'plank'], 'brett': ['plank'], 'bretter': ['plank'],
  'wasserflasche': ['water', 'bottle'], 'flasche': ['bottle'],
  'metallplatte': ['metal', 'plate'], 'blech': ['metal', 'plate'],
  'kabeltrommel': ['cable', 'reel'], 'seekiste': ['sea', 'chest'],
  'autozelt': ['car', 'tent'], 'zelt': ['tent'], 'streichholz': ['match'], 'streichhoelzer': ['match'],
  'messer': ['knife'], 'axt': ['axe'], 'schaufel': ['shovel'], 'seil': ['rope'], 'fass': ['barrel'],
  'gewehr': ['rifle'], 'pistole': ['pistol'], 'magazin': ['mag'], 'munition': ['ammo'],
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
  const nameTokens = splitIdentifier(name);
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
  const tokens = queryTokens(query, TYPE_SYNONYMS).filter((t) => !['class', 'classname', 'typename', 'type', 'item', 'gegenstand', 'dayz', 'heisst', 'heißt', 'wie', 'ist', 'der', 'die', 'das'].includes(t));
  return index.allTypeNames
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

function formatTypeAnswer(name: string): DayzCatalogAnswer {
  const index = getDayz129Index();
  const lines = [`**DayZ-Classname: \`${name}\`**`, ''];
  let found = false;
  for (const map of Object.keys(index.maps) as Dayz129Map[]) {
    const record = index.maps[map].types[name];
    if (!record) continue;
    found = true;
    lines.push(`- **${MAP_LABELS[map]}:** ${formatRecord(record)}`);
  }
  if (!found) lines.push('Der Name ist im globalen Index vorhanden, aber in keiner Map-Detailtabelle aufloesbar; das ist ein Indexfehler und wird nicht durch Raten ersetzt.');
  lines.push('', 'Die Werte oben stammen direkt aus deinen drei `types.xml`-Dateien. Kartenwerte werden getrennt gehalten und nicht zu einem erfundenen Universalwert zusammengezogen.');
  return { answer: lines.join('\n'), topic: 'type', ids: [`dayz129:type:${name}`] };
}

const EVENT_SYNONYMS: Record<string, string[]> = {
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

function formatEventAnswer(name: string): DayzCatalogAnswer {
  const index = getDayz129Index();
  const lines = [`**DayZ-Event: \`${name}\`**`, ''];
  for (const map of Object.keys(index.maps) as Dayz129Map[]) {
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

function isTypeLookupIntent(question: string): boolean {
  const q = fold(question);
  return /\b(class|classname|class name|typename|type name|itemname|item name)\b/.test(q)
    || /wie\s+(heisst|heißt).*\b(item|gegenstand|class|classname)\b/.test(q)
    || /\b(holzbretter|holzbrett|nagelbox|naegelbox|nägelbox|wasserflasche|metallplatte|kabeltrommel|seekiste|autozelt)\b/.test(q);
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
  if (exactType && (isTypeLookupIntent(question) || q.includes(fold(exactType)))) return formatTypeAnswer(exactType);

  if (isTypeLookupIntent(question)) {
    const candidates = searchDayz129Types(question, 5);
    if (candidates.length === 1) return formatTypeAnswer(candidates[0]);
    if (candidates.length > 1) return candidateListAnswer('type', candidates);
    return {
      answer: 'Dazu finde ich **keinen passenden Classname** unter den 1.974 realen Classnames aus deinen drei 1.29-`types.xml`-Dateien. Ich rate keinen Namen. Beschreibe den Gegenstand etwas genauer.',
      topic: 'type-search', ids: ['dayz129:type:not-found'],
    };
  }

  const exactEvent = findExactIndexedName(question, index.allEventNames, eventByLower!);
  if (exactEvent && (isEventLookupIntent(question) || q.includes(fold(exactEvent)))) return formatEventAnswer(exactEvent);

  if (isEventLookupIntent(question)) {
    const candidates = searchDayz129Events(question, 5);
    if (candidates.length === 1) return formatEventAnswer(candidates[0]);
    if (candidates.length > 1) return candidateListAnswer('event', candidates);
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
  if (q.length > 160 || !/(beispiel|wie genau|warum|was bedeutet|kannst du|zeig|und wie|und was|nochmal|dazu|welcher wert|welche werte)/i.test(q)) return question;
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
