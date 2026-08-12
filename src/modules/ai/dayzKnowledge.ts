/**
 * DayZ 1.29 grounded knowledge.
 *
 * Sources: the three supplied 1.29 vanilla datasets, Bohemia DZ_129,
 * Bohemia DayZ documentation, and Nitrado only for hosting procedures.
 */

export type DayzMap = 'chernarus' | 'livonia' | 'sakhal';

export interface DayzMapProfile {
  label: string;
  mission: string;
  zipFileCount: number;
  typesCount: number;
  eventsCount: number;
  maxTypeNominal: number;
  typeNominalOver25: number;
  maxTypeMin: number;
  typeMinOver25: number;
  positiveMinEqualsNominal: number;
  maxLifetime: number;
  maxRestock: number;
  eventGroupCount: number;
  eventPositionCount: number;
  effectAreaCount: number;
  undergroundTriggerCount: number;
  playerSpawn: { freshGroups: number; freshPositions: number; hopGroups: number; hopPositions: number; travelGroups: number; travelPositions: number };
}

export const DAYZ_129_PROFILES: Record<DayzMap, DayzMapProfile> = {
  chernarus: {
    label: 'Chernarus', mission: 'dayzOffline.chernarusplus', zipFileCount: 42,
    typesCount: 1942, eventsCount: 59, maxTypeNominal: 120, typeNominalOver25: 246,
    maxTypeMin: 95, typeMinOver25: 135, positiveMinEqualsNominal: 8,
    maxLifetime: 3888000, maxRestock: 43200, eventGroupCount: 83,
    eventPositionCount: 1435, effectAreaCount: 9, undergroundTriggerCount: 0,
    playerSpawn: { freshGroups: 11, freshPositions: 49, hopGroups: 10, hopPositions: 50, travelGroups: 10, travelPositions: 50 },
  },
  livonia: {
    label: 'Livonia', mission: 'dayzOffline.enoch', zipFileCount: 42,
    typesCount: 1939, eventsCount: 53, maxTypeNominal: 110, typeNominalOver25: 109,
    maxTypeMin: 95, typeMinOver25: 67, positiveMinEqualsNominal: 15,
    maxLifetime: 3888000, maxRestock: 43200, eventGroupCount: 61,
    eventPositionCount: 693, effectAreaCount: 8, undergroundTriggerCount: 8,
    playerSpawn: { freshGroups: 12, freshPositions: 63, hopGroups: 6, hopPositions: 44, travelGroups: 6, travelPositions: 44 },
  },
  sakhal: {
    label: 'Sakhal', mission: 'dayzOffline.sakhal', zipFileCount: 34,
    typesCount: 1955, eventsCount: 62, maxTypeNominal: 150, typeNominalOver25: 82,
    maxTypeMin: 140, typeMinOver25: 46, positiveMinEqualsNominal: 3,
    maxLifetime: 3888000, maxRestock: 43200, eventGroupCount: 1,
    eventPositionCount: 753, effectAreaCount: 50, undergroundTriggerCount: 30,
    playerSpawn: { freshGroups: 1, freshPositions: 39, hopGroups: 1, hopPositions: 39, travelGroups: 1, travelPositions: 39 },
  },
};

interface TypeReference {
  nominal: number;
  min: number;
  lifetime: number;
  restock: number;
  usage?: string[];
  category?: string[];
  value?: string[];
}

/** Exact examples extracted from the supplied 1.29 types.xml files. */
export const DAYZ_129_TYPE_REFERENCES: Record<string, Partial<Record<DayzMap, TypeReference>>> = {
  M4A1: {
    chernarus: { nominal: 1, min: 1, lifetime: 7200, restock: 3600, usage: ['ContaminatedArea'] },
    livonia: { nominal: 1, min: 1, lifetime: 7200, restock: 3600, usage: ['ContaminatedArea'] },
    sakhal: { nominal: 2, min: 1, lifetime: 7200, restock: 7200, usage: ['Special'] },
  },
  SVD: {
    chernarus: { nominal: 1, min: 1, lifetime: 7200, restock: 3600, usage: ['ContaminatedArea'] },
    livonia: { nominal: 2, min: 1, lifetime: 7200, restock: 3600, usage: ['Military'] },
    sakhal: { nominal: 0, min: 0, lifetime: 7200, restock: 10800, usage: ['Underground'] },
  },
  AKM: {
    chernarus: { nominal: 3, min: 2, lifetime: 7200, restock: 3600, usage: ['Military'], value: ['Tier4'] },
    livonia: { nominal: 2, min: 1, lifetime: 7200, restock: 3600, usage: ['Military'] },
    sakhal: { nominal: 2, min: 1, lifetime: 7200, restock: 10800, usage: ['Underground'] },
  },
  Mosin9130: {
    chernarus: { nominal: 40, min: 35, lifetime: 7200, restock: 0, usage: ['Town', 'Village', 'Hunting'], value: ['Tier2', 'Tier3', 'Tier4'] },
    livonia: { nominal: 16, min: 10, lifetime: 7200, restock: 0, usage: ['Village', 'Hunting'], value: ['Tier2', 'Tier3'] },
    sakhal: { nominal: 10, min: 7, lifetime: 7200, restock: 0, usage: ['Hunting'], value: ['Tier2'] },
  },
  WaterBottle: {
    chernarus: { nominal: 100, min: 85, lifetime: 7200, restock: 0 },
    livonia: { nominal: 50, min: 30, lifetime: 7200, restock: 0 },
    sakhal: { nominal: 30, min: 25, lifetime: 7200, restock: 0 },
  },
  NailBox: {
    chernarus: { nominal: 90, min: 70, lifetime: 14400, restock: 0 },
    livonia: { nominal: 70, min: 50, lifetime: 14400, restock: 0 },
    sakhal: { nominal: 55, min: 50, lifetime: 14400, restock: 0 },
  },
  MetalPlate: {
    chernarus: { nominal: 60, min: 40, lifetime: 14400, restock: 0 },
    livonia: { nominal: 80, min: 50, lifetime: 14400, restock: 0 },
    sakhal: { nominal: 50, min: 40, lifetime: 14400, restock: 0 },
  },
  PowerGenerator: {
    chernarus: { nominal: 80, min: 50, lifetime: 28800, restock: 0 },
    livonia: { nominal: 80, min: 50, lifetime: 28800, restock: 0 },
    sakhal: { nominal: 40, min: 33, lifetime: 28800, restock: 0 },
  },
  CableReel: {
    chernarus: { nominal: 80, min: 50, lifetime: 28800, restock: 0 },
    livonia: { nominal: 80, min: 50, lifetime: 28800, restock: 0 },
    sakhal: { nominal: 45, min: 35, lifetime: 28800, restock: 0 },
  },
  LargeTent: {
    chernarus: { nominal: 8, min: 4, lifetime: 3888000, restock: 43200 },
    livonia: { nominal: 8, min: 4, lifetime: 3888000, restock: 43200 },
    sakhal: { nominal: 8, min: 4, lifetime: 3888000, restock: 43200 },
  },
  CarTent: {
    chernarus: { nominal: 8, min: 4, lifetime: 3888000, restock: 43200 },
    livonia: { nominal: 8, min: 4, lifetime: 3888000, restock: 43200 },
    sakhal: { nominal: 8, min: 4, lifetime: 3888000, restock: 43200 },
  },
  SeaChest: {
    chernarus: { nominal: 20, min: 10, lifetime: 3888000, restock: 0, category: ['tools'], usage: ['Industrial', 'Farm', 'Coast', 'Hunting'] },
    livonia: { nominal: 20, min: 10, lifetime: 3888000, restock: 0, category: ['tools'], usage: ['Industrial', 'Farm', 'Coast'] },
    sakhal: { nominal: 13, min: 8, lifetime: 3888000, restock: 0, category: ['containers'], usage: ['Industrial', 'Farm', 'Coast'] },
  },
  Matchbox: { sakhal: { nominal: 150, min: 140, lifetime: 7200, restock: 0 } },
};

interface FileFact {
  id: string;
  aliases: string[];
  purpose: string;
  observed: string[];
  caveats?: string[];
}

const FILE_FACTS: FileFact[] = [
  {
    id: 'types.xml', aliases: ['types.xml', 'typesxml', 'nominal', 'restock', 'lifetime', 'quantmin', 'quantmax'],
    purpose: '`db/types.xml` definiert spawnfaehige Typen und CE-Limiter/Felder wie `nominal`, `min`, `lifetime`, `restock`, Kategorien, Usage/Value/Tag und Flags.',
    observed: [
      'Die drei 1.29-Datensaetze widerlegen eine pauschale Obergrenze 25: Chernarus hat `nominal` bis 120, Livonia bis 110, Sakhal bis 150.',
      '`min == nominal` kommt in allen drei Datensaetzen bei positiven Werten vor; daraus darf keine universelle Regel `min < nominal` konstruiert werden.',
      '1920 Typnamen kommen in allen drei Karten vor; 1539 davon unterscheiden sich in mindestens einem ausgewerteten CE-Feld.',
      '`lifetime` reicht bis 3.888.000 Sekunden und `restock` bis 43.200 Sekunden; eine pauschale 28.800-Sekunden-Obergrenze ist falsch.',
    ],
    caveats: ['Konkrete Item-Werte nur aus einer eingebetteten 1.29-Referenz oder einer echten Serverdatei nennen.'],
  },
  {
    id: 'events.xml', aliases: ['events.xml', 'eventsxml', 'dynamische events', 'dynamic event', 'event spawn'],
    purpose: '`db/events.xml` definiert dynamische CE-Events, z. B. Fahrzeuge, Tiere und Infected. Felder wie `nominal`, `min`, `max`, `lifetime`, `restock`, `position`, `limit`, `active` und `children` sind eventbezogen zu lesen.',
    observed: ['1.29: Sakhal 62 Events, Livonia 53, Chernarus 59.', 'Event-Werte ueber 25 sind regulaer vorhanden; `max` reicht in den untersuchten Datensaetzen bis 250.', 'Event-Felder nicht als universelles types.xml-Lagerverhaeltnis interpretieren.'],
  },
  {
    id: 'economy.xml', aliases: ['db/economy.xml', 'economy.xml'],
    purpose: '`db/economy.xml` ist eine regulaere Mission-Datei der Central Economy und steuert fuer Entity-Gruppen CE-Initialisierung, Laden, Speichern und Respawn.',
    observed: ['Sie liegt in allen drei gelieferten 1.29-Datensaetzen und in der Bohemia-DZ_129-Referenz fuer alle drei Karten.'],
    caveats: ['Nicht mit Wetter verwechseln: Wetter wird ueber `cfgweather.xml` konfiguriert.'],
  },
  {
    id: 'globals.xml', aliases: ['globals.xml', 'db/globals.xml', 'flagrefreshfrequency', 'zombiemaxcount', 'animalmaxcount'],
    purpose: '`db/globals.xml` enthaelt globale CE-Variablen fuer Limits, Cleanup, Respawn, Login und Flag-Refresh-Verhalten.',
    observed: ['Die drei untersuchten 1.29-`globals.xml` sind inhaltlich identisch.'],
    caveats: ['Grosse Werte hier sind normal und nicht mit `nominal/min` eines einzelnen Types gleichzusetzen.'],
  },
  {
    id: 'messages.xml', aliases: ['messages.xml', 'db/messages.xml'],
    purpose: '`db/messages.xml` ist ein CE/Mission-Dateityp fuer Server-Messages und kann ueber CE-Modding als `messages` eingebunden werden.',
    observed: ['Chernarus und Livonia enthalten die Datei; die untersuchte Sakhal-1.29-Mission nicht.'],
    caveats: ['Nicht behaupten, jeder Vanilla-Missionsordner muesse diese Datei zwingend enthalten.'],
  },
  {
    id: 'cfgspawnabletypes.xml', aliases: ['cfgspawnabletypes.xml', 'cfgspawnabletypes', 'attachments chance', 'cargo chance'],
    purpose: '`cfgspawnabletypes.xml` definiert zufaellige Cargo-Inhalte und Attachments fuer Typen; Presets koennen aus `cfgrandompresets.xml` referenziert werden.',
    observed: ['1.29: Sakhal 582, Livonia 576, Chernarus 574 `<type>`-Definitionen; 573 Typnamen sind allen drei gemeinsam.'],
    caveats: ['Es ist XML, nicht `cfgSpawnableTypes.json`.'],
  },
  {
    id: 'cfgrandompresets.xml', aliases: ['cfgrandompresets.xml', 'random preset', 'cargo preset', 'attachments preset'],
    purpose: '`cfgrandompresets.xml` definiert wiederverwendbare Presets fuer Cargo und Attachments, die `cfgspawnabletypes.xml` nutzen kann.',
    observed: ['1.29: Sakhal 78 Presets, Livonia 71, Chernarus 78; 71 sind allen drei gemeinsam.'],
  },
  {
    id: 'cfgeventspawns.xml', aliases: ['cfgeventspawns.xml', 'event position', 'event spawnpunkte', 'vehicle position'],
    purpose: '`cfgeventspawns.xml` enthaelt Weltpositionen und Rotationen/Zonen fuer dynamische Events.',
    observed: ['Sakhal: 47 Eventdefinitionen, 753 `<pos>`, 5 `<zone>`.', 'Livonia: 31 Eventdefinitionen, 693 `<pos>`, 8 `<zone>`.', 'Chernarus: 33 Eventdefinitionen, 1435 `<pos>`, 9 `<zone>`.'],
  },
  {
    id: 'cfgeventgroups.xml', aliases: ['cfgeventgroups.xml', 'event group', 'eventgruppe'],
    purpose: '`cfgeventgroups.xml` beschreibt gruppierte Event-Objektanordnungen/Children.',
    observed: ['Sakhal: 1 Gruppe/2 Children; Livonia: 61/709; Chernarus: 83/874.', 'Das ist eine echte Kartenvariation; die kleine Sakhal-Datei darf nicht allein aufgrund ihrer Groesse als unvollstaendig bezeichnet werden.'],
  },
  {
    id: 'cfgplayerspawnpoints.xml', aliases: ['cfgplayerspawnpoints.xml', 'player spawn', 'fresh spawn', 'hop spawn', 'travel spawn'],
    purpose: '`cfgplayerspawnpoints.xml` definiert Regeln/Basispositionen fuer `fresh`, `hop` und `travel` Player-Spawns.',
    observed: ['Sakhal: je 1 Gruppe/39 Positionen.', 'Livonia: fresh 12/63, hop 6/44, travel 6/44.', 'Chernarus: fresh 11/49, hop 10/50, travel 10/50.'],
  },
  {
    id: 'cfggameplay.json', aliases: ['cfggameplay.json', 'gameplay settings', 'objectspawnersarr', 'disablepersonallight'],
    purpose: '`cfggameplay.json` ist die Gameplay-Settings-Datei der Mission und muss ueber die Serverkonfiguration aktiviert werden, damit sie genutzt wird.',
    observed: ['Gleiche Grundstruktur, aber mapbezogene Werte unterscheiden sich.', '`WorldsData.lightingConfig`: Sakhal 2, Livonia 0, Chernarus 0.', 'Sakhal referenziert `pra/warheadstorage.json` in `playerRestrictedAreaFiles`; Livonia/Chernarus nicht.'],
  },
  {
    id: 'cfgEffectArea.json', aliases: ['cfgeffectarea.json', 'effectarea', 'contaminated area', 'kontaminierte zone', 'gas zone'],
    purpose: '`cfgEffectArea.json` definiert statische Effect-/Kontaminationsbereiche; dynamische Kontaminationszonen laufen ueber CE-Events.',
    observed: ['Sakhal: 50 Areas mit stark anderer Geysir-/Vulkan-Struktur.', 'Livonia: 8 Areas + 27 SafePositions.', 'Chernarus: 9 Areas + 55 SafePositions.', 'Bohemia hat die Static-Contaminated-Area-Konfiguration ab 1.28 geaendert.'],
  },
  {
    id: 'cfgundergroundtriggers.json', aliases: ['cfgundergroundtriggers.json', 'underground trigger', 'breadcrumbs', 'untergrund', 'bunker trigger'],
    purpose: '`cfgundergroundtriggers.json` definiert Underground-`Triggers` und `Breadcrumbs`, u. a. fuer Praesenz- und Eye-Accommodation-/Dunkelheitslogik.',
    observed: ['Sakhal: 30 Triggers/21 Breadcrumbs.', 'Livonia: 8/21.', 'Chernarus: 0 Triggers in der gelieferten Datei.'],
  },
  {
    id: 'cfgweather.xml', aliases: ['cfgweather.xml', 'wetter', 'weather', 'regen', 'rain', 'snowfall', 'schnee'],
    purpose: '`cfgweather.xml` konfiguriert Missionswetter wie Overcast, Fog, Rain, Wind, Snowfall und Storm.',
    observed: ['Alle drei nutzen dieselbe Grundstruktur.', 'Sakhal begrenzt Rain in der gelieferten Datei auf 0 und konfiguriert Snowfall.', 'Livonia und Chernarus erlauben Rain-Bereiche bis 1.0.'],
  },
  {
    id: 'cfgeconomycore.xml', aliases: ['cfgeconomycore.xml', 'economycore', 'world_segments', 'backup_period'],
    purpose: '`cfgeconomycore.xml` konfiguriert CE-Rootklassen, Defaults, Persistence-Backups, Logging/Updater und kann zusaetzliche CE-Dateien zum Append/Override einbinden.',
    observed: ['Sakhal/Chernarus haben 18 `<default>`-Eintraege, Livonia 19.'],
    caveats: ['Bohemia weist darauf hin, `world_segments` an Karte/Entity-Menge anzupassen; Chernarus-Werte sind kein Universaldefault.'],
  },
  {
    id: 'cfgenvironment.xml', aliases: ['cfgenvironment.xml', 'animal herd', 'territories', 'tierherde'],
    purpose: '`cfgenvironment.xml` verbindet Tier-/Infected-Umgebungsdefinitionen mit Territory-Dateien unter `env/`.',
    observed: ['Tierarten/Territory-Dateien sind mapbezogen; Sakhal besitzt z. B. `reindeer_territories.xml`.'],
  },
  {
    id: 'cfglimitsdefinition.xml', aliases: ['cfglimitsdefinition.xml', 'cfglimitsdefinitionuser.xml', 'limitsdefinition', 'tier1234', 'tier234'],
    purpose: '`cfglimitsdefinition.xml` definiert CE-Limiter-Namen fuer Usage/Value/Tag/Category; `cfglimitsdefinitionuser.xml` kann Kombinationsdefinitionen bereitstellen.',
    observed: ['Sakhal/Chernarus enthalten in den gelieferten User-Definitionen mehr kombinierte Tier-Aliase als Livonia.'],
  },
  {
    id: 'mapgroupproto.xml', aliases: ['mapgroupproto.xml', 'mapgrouppos.xml', 'loot in gebaeuden', 'loot in häusern', 'loot in haeusern'],
    purpose: '`mapgroupproto.xml` beschreibt Standard-Mapgroup-/Gebaeude-Prototypen inklusive Loot-Containern/Spawnpunkten; `mapgrouppos.xml` enthaelt exportierte Weltpositionen.',
    observed: ['mapgrouppos-Gruppen: Sakhal 8332, Livonia 5723, Chernarus 11679.', 'mapgroupproto-Prototypen: Sakhal 523, Livonia 444, Chernarus 424.', 'Loot-Space ist terrainabhaengig; CE-Mengen nicht blind zwischen Karten kopieren.'],
  },
  {
    id: 'mapclusterproto.xml', aliases: ['mapclusterproto.xml', 'mapgroupcluster.xml', 'mapgroupcluster01.xml', 'cluster mapgroup', 'fruit tree', 'mushroom'],
    purpose: '`mapclusterproto.xml` definiert Cluster-Mapgroup-Prototypen; `mapgroupcluster*.xml` enthaelt exportierte Positionen und kann auf mehrere nummerierte Dateien verteilt sein.',
    observed: ['Anzahl/Aufteilung der `mapgroupcluster*.xml`-Dateien variiert zwischen den Karten.'],
  },
  {
    id: 'env-territories', aliases: ['_territories.xml', 'territory', 'territories', 'zombie_territories', 'wolf_territories', 'bear_territories', 'reindeer_territories'],
    purpose: '`env/*_territories.xml` enthaelt kartenbezogene Zonen/Positionen fuer Tiere und Infected.',
    observed: ['Zombie-Zonen: Sakhal 417, Livonia 328, Chernarus 768.', 'Sakhal besitzt Reindeer-Territories; die Tierdatei-Auswahl ist mapbezogen.'],
  },
  {
    id: 'init.c', aliases: ['init.c', 'startingequipsetup', 'createcustommission', 'startausruestung', 'spawn loadout'],
    purpose: '`init.c` ist das Missions-Initialisierungsskript. Vanilla-Missionen initialisieren dort die CE und koennen Karten-/Startausruestungslogik enthalten.',
    observed: ['Die Dateien unterscheiden sich zwischen Karten; Kartenlogik nicht als universelle Vorlage ausgeben.'],
  },
];

const MAP_ALIASES: Record<DayzMap, string[]> = {
  chernarus: ['chernarus', 'chernarusplus', 'dayzoffline.chernarusplus'],
  livonia: ['livonia', 'enoch', 'dayzoffline.enoch'],
  sakhal: ['sakhal', 'dayzoffline.sakhal', 'frostline'],
};

const ITEM_ALIASES: Record<string, string[]> = {
  M4A1: ['m4a1', 'm4'], SVD: ['svd', 'dragunov'], AKM: ['akm'],
  Mosin9130: ['mosin9130', 'mosin 9130', 'mosin'], WaterBottle: ['waterbottle', 'water bottle', 'wasserflasche'],
  NailBox: ['nailbox', 'nail box', 'nagelbox', 'nägelbox', 'naegelbox'], MetalPlate: ['metalplate', 'metal plate', 'metallplatte'],
  PowerGenerator: ['powergenerator', 'power generator', 'generator'], CableReel: ['cablereel', 'cable reel', 'kabeltrommel'],
  LargeTent: ['largetent', 'large tent', 'grosses zelt', 'großes zelt'], CarTent: ['cartent', 'car tent', 'autozelt'],
  SeaChest: ['seachest', 'sea chest', 'seekiste'], Matchbox: ['matchbox', 'streichholzschachtel'],
};

const ALL_MAPS: DayzMap[] = ['chernarus', 'livonia', 'sakhal'];
const lc = (text: string) => text.toLocaleLowerCase('de-DE');

export function detectDayzMaps(question: string): DayzMap[] {
  const q = lc(question);
  return ALL_MAPS.filter((map) => MAP_ALIASES[map].some((a) => q.includes(a)));
}

export function detectDayzFileFacts(question: string): FileFact[] {
  const q = lc(question);
  return FILE_FACTS.filter((f) => f.aliases.some((a) => q.includes(lc(a)))).slice(0, 3);
}

export function detectDayzTypeReference(question: string): string | null {
  const q = lc(question);
  for (const [name, aliases] of Object.entries(ITEM_ALIASES)) {
    if (aliases.some((a) => {
      const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(q);
    })) return name;
  }
  for (const name of Object.keys(DAYZ_129_TYPE_REFERENCES)) if (q.includes(name.toLowerCase())) return name;
  return null;
}

function formatTypeReference(name: string, requestedMaps: DayzMap[]): string[] {
  const ref = DAYZ_129_TYPE_REFERENCES[name];
  if (!ref) return [];
  const maps = requestedMaps.length ? requestedMaps : ALL_MAPS;
  const lines = [`1.29-REFERENZ fuer \`${name}\` (aus den gelieferten types.xml-Dateien):`];
  for (const map of maps) {
    const v = ref[map];
    if (!v) { lines.push(`- ${DAYZ_129_PROFILES[map].label}: in der eingebetteten Referenzauswahl kein Wert hinterlegt.`); continue; }
    const extra: string[] = [];
    if (v.usage?.length) extra.push(`usage=${v.usage.join('+')}`);
    if (v.value?.length) extra.push(`value=${v.value.join('+')}`);
    if (v.category?.length) extra.push(`category=${v.category.join('+')}`);
    lines.push(`- ${DAYZ_129_PROFILES[map].label}: nominal=${v.nominal}, min=${v.min}, lifetime=${v.lifetime}s, restock=${v.restock}s${extra.length ? `, ${extra.join(', ')}` : ''}.`);
  }
  if (requestedMaps.length === 0 && maps.length > 1) lines.push('- Wenn Kartenwerte abweichen, KEINEN davon als universellen Vanilla-Wert bezeichnen.');
  return lines;
}

function profileLines(map: DayzMap): string[] {
  const p = DAYZ_129_PROFILES[map];
  return [
    `${p.label} / \`${p.mission}\` (gelieferter 1.29-Datensatz):`,
    `- types.xml: ${p.typesCount} Typen; max nominal=${p.maxTypeNominal}; ${p.typeNominalOver25} nominal-Werte >25; max min=${p.maxTypeMin}; ${p.typeMinOver25} min-Werte >25; ${p.positiveMinEqualsNominal} positive Faelle min==nominal.`,
    `- events.xml: ${p.eventsCount} Events.`,
    `- cfgeventgroups: ${p.eventGroupCount} Gruppen; cfgeventspawns: ${p.eventPositionCount} Positionen.`,
    `- cfgEffectArea: ${p.effectAreaCount} Areas; cfgUndergroundTriggers: ${p.undergroundTriggerCount} Triggers.`,
  ];
}

const FOUR_CHECK = [
  'VIERFACHER HALLUZINATIONS-CHECK (vor jeder DayZ-Faktaussage):',
  '1. DATEI-BELEG: Ist die konkrete Struktur/Wertangabe in einem der drei gelieferten 1.29-Datensaetze belegt?',
  '2. KARTEN-VERGLEICH: Stimmen Chernarus/Livonia/Sakhal ueberein? Wenn nicht, als Variante erklaeren statt zu vereinheitlichen.',
  '3. OFFIZIELLE SEMANTIK: Bedeutung von Datei/Feld nur nach Bohemia-Dokumentation bzw. DZ_129-Referenz; Nitrado nur fuer Bedienpfade.',
  '4. ANTWORT-CHECK: Keine Zahl, kein Feld, kein Pfad und keine Abhaengigkeit hinzuerfinden. Bei fehlendem Beleg klar als nicht belegt kennzeichnen.',
];

export function buildDayzKnowledgeContext(question: string): { found: boolean; text: string; topicIds: string[] } {
  if (!question) return { found: false, text: '', topicIds: [] };
  const maps = detectDayzMaps(question);
  const facts = detectDayzFileFacts(question);
  const typeName = detectDayzTypeReference(question);
  const q = lc(question);
  const genericDayz = /\b(dayz|central economy|vanilla 1\.29|ce\b|loot|spawn)\b/i.test(q);
  if (facts.length === 0 && !typeName && !genericDayz && maps.length === 0) return { found: false, text: '', topicIds: [] };

  const lines: string[] = [
    'DAYZ 1.29 – GEERDETE ERKLAERBASIS',
    'Quellenrang: gelieferte 1.29-Dateien -> Bohemia DZ_129/Bohemia-Doku -> Nitrado-Doku nur fuer Nitrado-Bedienung.',
    'Die drei Karten sind Varianten derselben DayZ-CE-Welt, keine austauschbaren Wertetabellen.', '', ...FOUR_CHECK, '',
  ];

  for (const fact of facts) {
    lines.push(`### ${fact.id}`, fact.purpose);
    for (const o of fact.observed) lines.push(`- Beobachtet: ${o}`);
    for (const c of fact.caveats ?? []) lines.push(`- Grenze: ${c}`);
    lines.push('');
  }

  if (typeName) {
    if (!facts.some((f) => f.id === 'types.xml')) {
      const typesFact = FILE_FACTS.find((f) => f.id === 'types.xml')!;
      lines.push(`### ${typesFact.id}`, typesFact.purpose);
    }
    lines.push(...formatTypeReference(typeName, maps), '');
  }

  if (maps.length === 1 && (facts.length === 0 || /\b(vergleich|unterschied|profil|karte)\b/i.test(q))) {
    lines.push(...profileLines(maps[0]), '');
  } else if (maps.length > 1 || /\b(vergleich|unterschied|alle drei|karten)\b/i.test(q)) {
    for (const map of (maps.length ? maps : ALL_MAPS)) lines.push(...profileLines(map), '');
  }

  lines.push(
    'ANTWORTREGEL:',
    '- Erst erklaeren, WAS die Datei/Felder tun; dann die konkrete Kartenvariation nennen.',
    '- Exakte konkrete Item-/Event-Werte nur nennen, wenn sie im Kontext oben stehen oder aus einer echten Serverdatei kommen.',
    '- Niemals `>25` automatisch als falsch behandeln und niemals Werte automatisch auf 15/8/20 umschreiben.',
    '- Wenn der Nutzer "bei uns" fragt und keine echte Serverdatei im Kontext liegt, sagen, dass der konkrete Serverwert gelesen werden muss.',
  );

  return { found: true, text: lines.join('\n'), topicIds: [...facts.map((f) => `dayz129:${f.id}`), ...(typeName ? [`dayz129:type:${typeName}`] : []), ...maps.map((m) => `dayz129:map:${m}`)] };
}

export function getDayzGroundingTruthBlock(): string {
  return [
    'DAYZ 1.29 – HARTE GROUNDING-REGELN', ...FOUR_CHECK, '',
    'BELEGTE STRUKTUR-KORREKTUREN:',
    '- `db/economy.xml` ist eine regulaere CE-Missionsdatei und liegt in den drei untersuchten 1.29-Datensaetzen.',
    '- `db/messages.xml` ist in Chernarus/Livonia vorhanden, in der untersuchten Sakhal-1.29-Mission nicht.',
    '- `cfgspawnabletypes.xml` ist XML; Cargo/Attachments koennen Presets aus `cfgrandompresets.xml` nutzen.',
    '- `cfgEffectArea.json`, `cfgUndergroundTriggers.json` und `cfgGameplay.json` sind JSON-Dateien im Missionskontext.',
    '- Werte >25 in `types.xml` und `events.xml` sind in echten 1.29-Datensaetzen vorhanden. Keine pauschale 25-Grenze.',
    '- `min == nominal` kommt in echten 1.29-types.xml-Daten vor. Keine pauschale Regel `min < nominal` behaupten.',
    '- Kartenwerte nie gegenseitig ersetzen. Bei Unsicherheit Variante/fehlenden Beleg benennen.',
  ].join('\n');
}
