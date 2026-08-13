/**
 * Grounded Nitrado/DayZ help.
 * DayZ semantics: supplied 1.29 datasets + Bohemia references.
 * Nitrado: hosting procedures only.
 */
import { buildDayzKnowledgeContext, getDayzGroundingTruthBlock } from './dayzKnowledge';
import { isKnownDayz129Identifier } from './dayz129Catalog';

export interface HelpTopic {
  id: string;
  title: string;
  triggers: string[];
  body: string;
  directAnswer?: string;
}

export interface HelpAnswer {
  text: string;
  topicIds: string[];
  found: boolean;
  directAnswer?: string;
}

const EMPTY: HelpAnswer = { text: '', topicIds: [], found: false };

const BUILD_ANYWHERE_DIRECT_ANSWER = [
  'Fuer **Bauen+ / gelockerte Bauplatzierung** in Vanilla DayZ 1.29 nutzt du `cfggameplay.json`.',
  '',
  '1. Aktiviere die Gameplay-Datei in der gestarteten Server-Konfiguration mit `enableCfgGameplayFile = 1;`.',
  '2. Bearbeite in der Mission `cfggameplay.json` -> `BaseBuildingData`.',
  '3. Unter `HologramData` und `ConstructionData` setzt du nur die Pruefungen auf `true`, die du wirklich deaktivieren bzw. lockern willst.',
  '',
  'Relevante Platzierungschecks sind z. B. `disableIsCollidingBBoxCheck`, `disableIsCollidingPlayerCheck` und `disableIsPlacementPermittedCheck`. Fuer den eigentlichen Bauvorgang sind `disablePerformRoofCheck`, `disableIsCollidingCheck` und `disableDistanceCheck` relevant.',
].join('\n');

const EVENTS_XML_DIRECT_ANSWER = [
  'Die Datei heisst **`events.xml`**. `db/events.xml` definiert dynamische Events der DayZ Central Economy, z. B. Fahrzeuge, Tiere, Infected und statische Events wie Helikopter-Wracks.',
  '',
  'Typische Event-Felder sind `nominal`, `min`, `max`, `lifetime`, `restock`, `saferadius`, `distanceradius`, `cleanupradius`, `flags`, `position`, `limit`, `active` und `children`. Die vorgesehenen Weltpositionen eines Events werden getrennt in `cfgeventspawns.xml` beschrieben.',
].join('\n');

const EVENTS_XML_EXAMPLE = [
  '**Chernarus-1.29-Beispiel:** `StaticHeliCrash` hat `nominal=3`, `lifetime=2100`, `restock=0`, `position=fixed`, `limit=child` und `active=1`. Als Child ist `Wreck_UH1Y` hinterlegt.',
  '',
  '```xml',
  '<event name="StaticHeliCrash">',
  '  <nominal>3</nominal>',
  '  <min>0</min>',
  '  <max>0</max>',
  '  <lifetime>2100</lifetime>',
  '  <restock>0</restock>',
  '  <saferadius>1000</saferadius>',
  '  <distanceradius>1000</distanceradius>',
  '  <cleanupradius>1000</cleanupradius>',
  '  <secondary>InfectedArmy</secondary>',
  '  <flags deletable="1" init_random="0" remove_damaged="0"/>',
  '  <position>fixed</position>',
  '  <limit>child</limit>',
  '  <active>1</active>',
  '  <children>',
  '    <child lootmax="15" lootmin="10" max="3" min="1" type="Wreck_UH1Y"/>',
  '  </children>',
  '</event>',
  '```',
].join('\n');

const DAYZ_ENGINE_TOPICS: HelpTopic[] = [
  {
    id: 'events-xml',
    title: 'DayZ 1.29 – events.xml',
    triggers: ['events.xml', 'event.xml', 'event xml', 'eventxml', 'event-datei', 'event datei'],
    body: [
      '`db/events.xml` ist die Konfiguration fuer dynamische Central-Economy-Events.',
      'Belegte Eventarten umfassen unter anderem Fahrzeuge, Tiere, Infected und statische Events. Die Datei beschreibt WAS unter welchen Eventregeln erzeugt wird; `cfgeventspawns.xml` beschreibt die vorgesehenen Positionen.',
      'Belegte Felder sind unter anderem `nominal`, `min`, `max`, `lifetime`, `restock`, `saferadius`, `distanceradius`, `cleanupradius`, `flags`, `position`, `limit`, `active` und `children`.',
      'Intern beachten: nicht als Zeitplan-Datei interpretieren und keine Start-/Endzeitfelder, Wetterphasen oder automatisch geplanten Zombie-Wellen hinzudichten.',
      'Chernarus DZ_129 `StaticHeliCrash`: nominal=3, lifetime=2100, restock=0, Radien=1000, position=fixed, limit=child, active=1; Child `Wreck_UH1Y` mit lootmin=10, lootmax=15, min=1, max=3.',
    ].join('\n'),
    directAnswer: EVENTS_XML_DIRECT_ANSWER,
  },
  {
    id: 'tag-nacht-zyklus',
    title: 'DayZ Serverzeit / Tag-Nacht',
    triggers: ['tag/nacht', 'tag-nacht', 'tag nacht', 'nachtzeit', 'tageszeit', 'timeacceleration', 'servernighttimeacceleration', 'servertimeacceleration'],
    body: [
      'Die Dedicated-Server-Konfiguration kennt `serverTimeAcceleration` und `serverNightTimeAcceleration` fuer die Zeitbeschleunigung.',
      '`serverNightTimeAcceleration` wirkt als zusaetzlicher Multiplikator auf den bereits beschleunigten Server-Tag/Nacht-Zyklus.',
      'Keine Beispielzahl als "Vanilla-Pflichtwert" ausgeben, wenn nur nach der Funktionsweise gefragt wird.',
    ].join('\n'),
  },
  {
    id: 'slots-maxplayers',
    title: 'Maximale Spielerzahl',
    triggers: ['maxplayers', 'max players', 'spielerzahl', 'spieleranzahl', 'slots'],
    body: [
      '`maxPlayers` gehoert zur Dedicated-Server-Konfiguration und setzt die konfigurierte maximale Spielerzahl.',
      'Bei einem Hosting-Anbieter kann das gebuchte Produkt zusaetzlich eine harte Obergrenze setzen.',
      'Keine konkrete Slotzahl als Default erfinden, wenn sie nicht aus einer echten Server-Konfiguration oder expliziten Vorgabe stammt.',
    ].join('\n'),
  },
  {
    id: 'mission-wechseln',
    title: 'Mission / Karte',
    triggers: ['mission wechseln', 'karte wechseln', 'map wechseln', 'mission template', 'class missions', 'dayzoffline.chernarusplus', 'dayzoffline.enoch', 'dayzoffline.sakhal'],
    body: [
      'Die Dedicated-Server-Konfiguration enthaelt einen `class Missions`-Block; dessen `template` waehlt die Mission.',
      'Die drei untersuchten 1.29-Missionen heissen `dayzOffline.chernarusplus`, `dayzOffline.enoch` und `dayzOffline.sakhal`.',
      'Beim Kartenwechsel keine CE-Werte oder Missionsdateien blind von einer Karte auf die andere uebertragen: die drei 1.29-Datensaetze unterscheiden sich deutlich.',
    ].join('\n'),
  },
  {
    id: 'basebuilding-build-anywhere',
    title: 'DayZ 1.29 – Bauen+ / gelockerte Bauplatzierung',
    triggers: ['bauen+', 'bauen +', 'bauen plus', 'build anywhere', 'build-anywhere', 'buildanywhere', 'basebuilding', 'bauplatzierung', 'bauen aktivieren', 'bau aktivieren', 'construction check', 'placement check'],
    body: [
      'In ALLEN drei gelieferten Vanilla-1.29-`cfggameplay.json` (Chernarus, Livonia, Sakhal) liegt die Baukonfiguration unter `BaseBuildingData` mit `HologramData` und `ConstructionData`.',
      'Alle dort untersuchten Vanilla-1.29-Baupruefungen stehen in den drei Dateien standardmaessig auf `false`. Fuer Bauen+/Build-Anywhere werden gezielt die gewuenschten `disable...Check`-Schalter auf `true` gesetzt; `true` deaktiviert/lockert die jeweilige Pruefung.',
      'Belegte `HologramData`-Felder: `disableIsCollidingBBoxCheck`, `disableIsCollidingPlayerCheck`, `disableIsClippingRoofCheck`, `disableIsBaseViableCheck`, `disableIsCollidingGPlotCheck`, `disableIsCollidingAngleCheck`, `disableIsPlacementPermittedCheck`, `disableHeightPlacementCheck`, `disableIsUnderwaterCheck`, `disableIsInTerrainCheck`, `disableColdAreaPlacementCheck`, `disallowedTypesInUnderground`.',
      'Belegte `ConstructionData`-Felder: `disablePerformRoofCheck`, `disableIsCollidingCheck`, `disableDistanceCheck`.',
      'Die Gameplay-Datei wird erst genutzt, wenn die aktive Server-Konfiguration `enableCfgGameplayFile = 1;` setzt. Bohemia nennt die Datei generisch `server.cfg`; der reale Dateiname wird ueber `-config` gewaehlt und ist in vielen DayZ-Setups `serverDZ.cfg`.',
      '`disableBaseDamage` und `disableContainerDamage` sind separate Schadensregeln und NICHT der Schalter fuer freie Bauplatzierung.',
      'Intern verboten: `enableBuilding`, `EnableConstruction`, `BuildDistance`, `MaxConstructionObjects` fuer diesen Vanilla-1.29-Weg nicht als echte Parameter ausgeben.',
      'Nicht pauschal ALLE Checks auf `true` setzen, wenn nur eine einzelne Restriktion gelockert werden soll.',
    ].join('\n'),
    directAnswer: BUILD_ANYWHERE_DIRECT_ANSWER,
  },
  {
    id: 'mods-installieren',
    title: 'DayZ Mods – Grundprinzip',
    triggers: ['workshop mod', 'mods installieren', 'mod installieren', '-mod=', '-servermod='],
    body: [
      'DayZ-Mods werden serverseitig ueber Startparameter wie `-mod=` geladen.',
      'Bohemia unterstuetzt zusaetzliche CE-Dateien ueber `<ce folder="...">` in `cfgeconomycore.xml`; dokumentierte Typen sind `types`, `spawnabletypes`, `globals`, `economy`, `events` und `messages`.',
      'Konkrete Mod-Pfade/Abhaengigkeiten nur aus der jeweiligen Mod-Dokumentation nennen; nicht erraten.',
    ].join('\n'),
  },
];

const NITRADO_TOPICS: HelpTopic[] = [
  {
    id: 'nitrado-config-files',
    title: 'Nitrado – Konfigurationsdateien bearbeiten',
    triggers: ['nitrado', 'konfigurationsdateien', 'config files', 'serverdz.cfg', 'server config', 'dateibrowser'],
    body: [
      'Nitrado dokumentiert fuer DayZ **Einstellungen -> Konfigurationsdateien** fuer die Server-Konfiguration.',
      'Dort kann `serverDZ.cfg` bearbeitet, gespeichert und der Server anschliessend neu gestartet werden.',
      'Fuer Mission-/XML-/JSON-Dateien steht der Dateibrowser zur Verfuegung.',
      'Nitrado-Bedienpfade nicht mit DayZ-Engine-Semantik vermischen: Feldbedeutungen kommen aus Bohemia-/1.29-Referenzen.',
    ].join('\n'),
  },
];

function normalize(s: string): string { return s.toLocaleLowerCase('de-DE'); }

export function looksLikeDayZFileQuestion(question: string): boolean {
  if (!question) return false;
  const q = normalize(question);
  if (/\b(types|events?|globals|messages|economy)\.xml\b/.test(q)) return true;
  if (/\b(cfg[a-z0-9_]+|mapgroup[a-z0-9_]+|mapcluster[a-z0-9_]+)\.(xml|json)\b/.test(q)) return true;
  if (/\binit\.c\b|\bserverdz\.cfg\b/.test(q)) return true;
  if (/\bwelche\s+datei\b/.test(q) && /\b(dayz|loot|spawn|wetter|weather|tier|event|mission)\b/.test(q)) return true;
  return /\bloot\b.*\b(haus|häusern?|haeusern?|gebäuden?|gebaeuden?)\b/.test(q);
}

export function isDayzTechnicalAdminQuestion(question: string): boolean {
  if (!question) return false;
  const q = normalize(question);
  const hasDayz = /\bdayz\b|\bcentral economy\b|\bce\b/.test(q);
  const hasTechnical = /\b(server|nitrado|config|konfig|einstell|aktivier|deaktivier|bauen|bau|basebuilding|build|loot|spawn|event|xml|json|cfg|mission|mod|wetter|weather|lifetime|restock|nominal|globals|types|events)\b/.test(q)
    || /\.(xml|json|cfg|c)\b/.test(q);
  return (hasDayz && hasTechnical) || looksLikeDayZFileQuestion(question);
}

export function enrichDayzTechnicalFollowUp(question: string, previousAssistantText?: string | null): string {
  if (!question || !previousAssistantText) return question;
  const q = normalize(question).trim();
  if (q.length > 140 || !/(beispiel|wie genau|warum genau|was bedeutet das|kannst du das|kannst du mir|zeig mir|zeig das|und wie|und was|nochmal|dazu)/i.test(q)) return question;

  const match = previousAssistantText.match(/\b(?:events?|types|globals|messages|economy)\.xml\b|\b(?:cfg[a-z0-9_]+|mapgroup[a-z0-9_]+|mapcluster[a-z0-9_]+)\.(?:xml|json)\b|\bserverdz\.cfg\b|\binit\.c\b/i);
  if (!match) return question;
  let topic = match[0];
  if (/^event\.xml$/i.test(topic)) topic = 'events.xml';
  return `${topic}: ${question}`;
}

export const KNOWN_DAYZ_HALLUCINATED_IDENTIFIERS = [
  'enableBuilding', 'EnableConstruction', 'BuildDistance', 'MaxConstructionObjects',
  'cfgSpawnableTypes.json', 'lootcategories.xml',
] as const;

export function detectKnownDayzHallucinatedIdentifiers(text: string): string[] {
  if (!text) return [];
  return KNOWN_DAYZ_HALLUCINATED_IDENTIFIERS.filter((name) =>
    new RegExp(`(^|[^A-Za-z0-9_])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9_]|$)`, 'i').test(text));
}

function addMatches(out: Set<string>, text: string, re: RegExp, group = 0): void {
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const value = (m[group] ?? '').trim();
    if (value) out.add(value);
  }
}

export function extractDayzTechnicalIdentifiers(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  addMatches(out, text, /\b[A-Za-z0-9_.-]+\.(?:xml|json|cfg|c|txt|log|rpt)\b/gi);
  addMatches(out, text, /\b[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+\b/g);
  addMatches(out, text, /\b[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+\b/g);
  addMatches(out, text, /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/g);
  addMatches(out, text, /(?:^|\s)(-[A-Za-z][A-Za-z0-9]*)\b/gm, 1);
  addMatches(out, text, /"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g, 1);
  addMatches(out, text, /\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:true|false|-?\d+(?:\.\d+)?|"[^"]*")/g, 1);
  addMatches(out, text, /<\/?([A-Za-z_][A-Za-z0-9_]*)\b/g, 1);
  for (const match of text.matchAll(/`([^`\n]{1,160})`/g)) addMatches(out, match[1], /\b[A-Za-z_][A-Za-z0-9_.-]*\b/g);
  return [...out];
}

export interface DayzAnswerValidation { valid: boolean; violations: string[]; }

const GENERIC_ALLOWED_DAYZ_IDENTIFIERS = new Set([
  'DayZ', 'Chernarus', 'Livonia', 'Sakhal', 'Enoch', 'Frostline', 'true', 'false', 'XML', 'JSON', 'CE',
]);

function groundingContainsIdentifier(grounding: string, identifier: string): boolean {
  return GENERIC_ALLOWED_DAYZ_IDENTIFIERS.has(identifier) || normalize(grounding).includes(normalize(identifier));
}

function isBuildAnywhereQuestion(question: string): boolean {
  return /bauen\s*\+|bauen plus|build[ -]?anywhere|basebuilding|bauplatzierung|bauen aktivieren|bau aktivieren/.test(normalize(question));
}

function isEventsXmlQuestion(question: string): boolean {
  return /\bevents?\.xml\b|\bevent\s+xml\b|\beventxml\b/.test(normalize(question));
}

function wantsEventExample(question: string): boolean {
  return /\bbeispiel\b|\bzeig(?:en)?\b|\bcode\b|\baufbau\b|wie\s+sieht/.test(normalize(question));
}

function mentionsEventMisconception(question: string): boolean {
  return /startzeit|endzeit|zeitplan|regenphase|wetterphase|zombie.?welle|wave/.test(normalize(question));
}

function buildBuildAnywhereDirectAnswer(question: string): string {
  const bad = detectKnownDayzHallucinatedIdentifiers(question);
  if (bad.length === 0) return BUILD_ANYWHERE_DIRECT_ANSWER;
  return [
    BUILD_ANYWHERE_DIRECT_ANSWER,
    '',
    `Hinweis zu deiner Angabe: ${bad.map((name) => `\`${name}\``).join(', ')} ${bad.length === 1 ? 'ist' : 'sind'} kein belegter Vanilla-DayZ-1.29-Parameter fuer diesen Weg.`,
  ].join('\n');
}

function buildEventsXmlDirectAnswer(question: string): string {
  const parts = [EVENTS_XML_DIRECT_ANSWER];
  if (wantsEventExample(question)) parts.push('', EVENTS_XML_EXAMPLE);
  if (mentionsEventMisconception(question)) parts.push('', 'Falls du damit einen Start-/Endzeitplan, Wetterphasen oder zeitgesteuerte Zombie-Wellen meinst: Das wird nicht ueber `events.xml` als solchen Zeitplan gesteuert.');
  return parts.join('\n');
}

export function validateDayzTechnicalAnswer(answer: string, grounding: string, question = ''): DayzAnswerValidation {
  const violations = new Set<string>();
  if (!answer) return { valid: false, violations: ['leere Antwort'] };

  for (const bad of detectKnownDayzHallucinatedIdentifiers(answer)) {
    violations.add(`verbotener halluzinierter DayZ-Identifier: ${bad}`);
  }
  for (const identifier of extractDayzTechnicalIdentifiers(answer)) {
    if (isKnownDayz129Identifier(identifier)) continue;
    if (!groundingContainsIdentifier(grounding, identifier)) violations.add(`nicht im Grounding belegter Identifier: ${identifier}`);
  }

  if (isBuildAnywhereQuestion(question)) {
    for (const m of answer.matchAll(/\b(enableCfgGameplayFile|disable[A-Za-z0-9_]*Check)\s*=\s*(true|false|-?\d+(?:\.\d+)?)/g)) {
      const key = m[1];
      const value = m[2].toLowerCase();
      if (key === 'enableCfgGameplayFile' && value !== '1') violations.add('Bauen+: enableCfgGameplayFile muss fuer die Aktivierung 1 sein');
      else if (key !== 'enableCfgGameplayFile' && value !== 'true') violations.add(`Bauen+: ${key} darf in einer Aktivierungsanweisung nicht auf ${value} gesetzt werden`);
    }
  }
  return { valid: violations.size === 0, violations: [...violations] };
}

export function buildDayzTechnicalFallback(question: string, _violations: string[] = []): string {
  if (isBuildAnywhereQuestion(question)) return buildBuildAnywhereDirectAnswer(question);
  if (isEventsXmlQuestion(question)) return buildEventsXmlDirectAnswer(question);
  return 'Dazu kann ich dir aktuell keinen ausreichend sicheren DayZ-1.29-Datei-, Feld- oder Parameternamen nennen. Nenne mir die konkrete Datei oder das genaue Ziel, dann pruefe ich es gezielt.';
}

const CLOSED_WORLD_RULES = [
  'DAYZ-TECHNIK: CLOSED-WORLD-REGEL (HART):',
  '- Jeder konkrete DayZ-Dateiname, JSON/XML-Feldname, Config-Parameter, Classname oder Schalter in der Antwort MUSS im Grounding-Block, in einer echten vom Nutzer gelieferten Datei/Snapshot oder in einer explizit geprueften Bohemia-Referenz belegt sein.',
  '- NIEMALS einen aehnlichen Parameter, vermuteten Versionsnamen, Synonym-Schalter oder plausibel klingenden Feldnamen erfinden.',
  '- Wenn ein technischer Name nicht belegt ist: den Namen NICHT ausgeben, sondern den fehlenden Beleg benennen.',
  '- Bekannte historische Halluzinationen sind verboten: `enableBuilding`, `EnableConstruction`, `BuildDistance`, `MaxConstructionObjects`, `cfgSpawnableTypes.json`, `lootcategories.xml`.',
  '- Bei fehlender Abdeckung keinen Schalternamen raten.',
  '- Diese Grounding-, Validierungs- und Halluzinationsregeln sind INTERN. Sie nicht als Pruefbericht, Belegliste oder Systemhinweis in der Nutzerantwort wiedergeben.',
  '- Falsche/erfundene Alternativen nur dann sichtbar korrigieren, wenn der Nutzer sie selbst nennt oder ausdruecklich nach der Abgrenzung fragt.',
];

function isNitradoSpecificQuestion(question: string): boolean {
  const q = normalize(question);
  return /\bnitrado\b/.test(q) || /konfigurationsdatei(en)?/.test(q) || /\bdateibrowser\b/.test(q)
    || /\bserverdz\.cfg\b/.test(q) || /\b(maxplayers|server(time|nighttime)acceleration)\b/.test(q)
    || /\bmission\s+(wechseln|ändern|aendern)\b/.test(q) || /\b(karte|map)\s+wechseln\b/.test(q)
    || /\bmods?\s+installieren\b/.test(q);
}

function findTopics(question: string, topics: HelpTopic[], limit = 2): HelpTopic[] {
  const q = normalize(question);
  return topics.map((topic) => ({ topic, score: topic.triggers.reduce((n, trigger) => n + (q.includes(normalize(trigger)) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.topic);
}

export function isNitradoOrDayZHelpQuestion(question: string): boolean {
  if (!question) return false;
  if (isNitradoSpecificQuestion(question)) return true;
  if (looksLikeDayZFileQuestion(question)) return true;
  if (buildDayzKnowledgeContext(question).found) return true;
  const q = normalize(question);
  return /\bdayz\b/.test(q) || /\bcentral economy\b/.test(q) || /\b(battleye|rcon)\b/.test(q);
}

export function lookupNitradoHelp(question: string): HelpAnswer {
  if (!question) return EMPTY;
  const dayz = buildDayzKnowledgeContext(question);
  const engine = findTopics(question, DAYZ_ENGINE_TOPICS);
  const nitrado = findTopics(question, NITRADO_TOPICS);
  const technical = isDayzTechnicalAdminQuestion(question);
  if (!dayz.found && engine.length === 0 && nitrado.length === 0 && !technical) return EMPTY;

  const lines: string[] = [];
  const ids: string[] = [];
  if (dayz.found) { lines.push(dayz.text); ids.push(...dayz.topicIds); }
  if (engine.length) {
    if (lines.length) lines.push('');
    lines.push('GEPRUEFTE DAYZ-ENGINE-/SERVER-KONFIGURATION:');
    for (const topic of engine) { lines.push(`### ${topic.title}`, topic.body, ''); ids.push(`dayz-help:${topic.id}`); }
  }
  if (nitrado.length) {
    if (lines.length) lines.push('');
    lines.push('NITRADO-BEDIENWEG (Hosting-Prozedur, nicht DayZ-Dateisemantik):');
    for (const topic of nitrado) { lines.push(`### ${topic.title}`, topic.body, ''); ids.push(`nitrado:${topic.id}`); }
  }

  const hasSpecificGrounding = dayz.topicIds.length > 0 || engine.length > 0 || nitrado.length > 0;
  if (technical) {
    lines.push('', ...CLOSED_WORLD_RULES, '');
    if (!hasSpecificGrounding) lines.push(
      'GROUNDING-STATUS: NICHT AUSREICHEND BELEGT.',
      'HARTE ANTWORTVORGABE: Keine konkrete Datei, kein Feld und keinen Parameter erfinden. Nutzerseitig nur knapp sagen, dass die konkrete Einstellung nicht sicher bestaetigt werden kann; keine internen Pruefdetails nennen.',
      '',
    );
  }
  lines.push(
    'AUSGABEREGELN:',
    '- Antworte zuerst direkt, kompakt und nutzerorientiert. Keine internen Grounding-/Validierungsdetails ungefragt ausgeben.',
    '- Keine Listen erfundener oder historisch falscher Alternativen anhaengen, ausser der Nutzer hat genau so einen Begriff genannt oder fragt nach der Abgrenzung.',
    '- Beispiele, lange Feldlisten und Zusatzkontext nur ausgeben, wenn die Frage sie benoetigt oder der Nutzer danach fragt.',
    '- Keine Hostnames, IPs, Tokens, Service-IDs oder sonstige Server-Interna ausdenken.',
    '- Bei "unser Server / bei uns": konkrete Werte nur aus einer echten Serverdatei bzw. einem sicheren Server-Snapshot nennen.',
    '- Bei Kartenunterschieden die Karte benennen; niemals Chernarus-, Livonia- und Sakhal-Werte vermischen.',
    '- Wenn etwas nicht sicher belegt ist, kurz sagen, dass du es nicht sicher bestaetigen kannst; keine plausibel klingenden Details ergaenzen.',
  );

  let directAnswer: string | undefined;
  if (engine.some((topic) => topic.id === 'basebuilding-build-anywhere')) directAnswer = buildBuildAnywhereDirectAnswer(question);
  else if (engine.some((topic) => topic.id === 'events-xml')) directAnswer = buildEventsXmlDirectAnswer(question);
  else directAnswer = engine.find((topic) => topic.directAnswer)?.directAnswer;

  return { text: lines.join('\n'), topicIds: [...new Set(ids)], found: true, ...(directAnswer ? { directAnswer } : {}) };
}

export function getDayZFileTruthBlock(): string {
  return [getDayzGroundingTruthBlock(), '', ...CLOSED_WORLD_RULES].join('\n');
}

/** Legacy APIs kept for compatibility: no fabricated numeric rewrite. */
export function detectTypesXmlValueViolations(_text: string): string[] { return []; }
export interface SanitizeLootResult { text: string; changes: string[]; }
export function sanitizeDayZLootValues(text: string): SanitizeLootResult { return { text, changes: [] }; }
export function looksLikeDayZLootContent(text: string): boolean {
  if (!text) return false;
  return /\b(types\.xml|events\.xml|central economy|dayz|loot|nominal|restock|lifetime)\b/i.test(text)
    || /<(nominal|min|max|restock|lifetime)>/i.test(text)
    || /\b(nominal|min|max)\s*=\s*"\d+"/i.test(text);
}