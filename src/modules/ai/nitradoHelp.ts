/**
 * Grounded Nitrado/DayZ help for the AI layer.
 *
 * DayZ semantics come from `dayzKnowledge.ts`, based on the three supplied
 * DayZ 1.29 vanilla datasets and cross-checked against Bohemia DZ_129/docs.
 * Nitrado facts here are limited to documented hosting procedures.
 */

import { buildDayzKnowledgeContext, getDayzGroundingTruthBlock } from './dayzKnowledge';

export interface HelpTopic {
  id: string;
  title: string;
  triggers: string[];
  body: string;
}

export interface HelpAnswer {
  text: string;
  topicIds: string[];
  found: boolean;
}

const EMPTY: HelpAnswer = { text: '', topicIds: [], found: false };

const NITRADO_TOPICS: HelpTopic[] = [
  {
    id: 'nitrado-config-files',
    title: 'Nitrado – Konfigurationsdateien bearbeiten',
    triggers: ['nitrado', 'konfigurationsdateien', 'config files', 'serverdz.cfg', 'server config'],
    body: [
      'Nitrado dokumentiert fuer DayZ **Einstellungen -> Konfigurationsdateien** fuer die Server-Konfiguration.',
      'Dort kann bei Nitrado `serverDZ.cfg` ausgewaehlt, gespeichert und anschliessend der Server neu gestartet werden.',
      'Fuer Mission-/XML-Dateien dokumentiert Nitrado **Tools -> Dateibrowser**.',
      'Bei Console-Missionsdateien empfiehlt Nitrado: Server stoppen, 3-5 Minuten warten, Datei bearbeiten/speichern und danach wieder starten.',
      'Nitrado-Bedienpfade nicht mit DayZ-Engine-Semantik vermischen: Was XML/JSON-Felder bedeuten, kommt aus Bohemia-/1.29-Referenzen.',
    ].join('\n'),
  },
  {
    id: 'tag-nacht-zyklus',
    title: 'DayZ Serverzeit / Tag-Nacht',
    triggers: ['tag/nacht', 'tag-nacht', 'tag nacht', 'nachtzeit', 'tageszeit', 'timeacceleration', 'servernighttimeacceleration', 'servertimeacceleration'],
    body: [
      'Die Dedicated-Server-Konfiguration kennt `serverTimeAcceleration` und `serverNightTimeAcceleration` fuer die Zeitbeschleunigung.',
      '`serverNightTimeAcceleration` wirkt als zusaetzlicher Multiplikator auf den bereits beschleunigten Server-Tag/Nacht-Zyklus.',
      'Bei Nitrado wird die Server-Konfiguration ueber die Konfigurationsdateien bearbeitet; nach der Aenderung speichern und neu starten.',
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
      'Bei Nitrado: Einstellungen/Konfigurationsdateien -> Server-Konfiguration bearbeiten -> speichern -> neu starten.',
    ].join('\n'),
  },
  {
    id: 'mission-wechseln',
    title: 'Mission / Karte',
    triggers: ['mission wechseln', 'karte wechseln', 'map wechseln', 'mission template', 'class missions', 'dayzoffline.chernarusplus', 'dayzoffline.enoch', 'dayzoffline.sakhal'],
    body: [
      'Die Dedicated-Server-Konfiguration enthaelt einen `class Missions`-Block; dessen `template` waehlt die Mission.',
      'Die drei untersuchten 1.29-Missionen heissen `dayzOffline.chernarusplus`, `dayzOffline.enoch` und `dayzOffline.sakhal`.',
      'Beim Kartenwechsel keine CE-Werte oder Missionsdateien blind von einer Karte auf die andere uebertragen: die 1.29-Datensaetze unterscheiden sich deutlich.',
    ].join('\n'),
  },
  {
    id: 'mods-installieren',
    title: 'DayZ Mods – Grundprinzip',
    triggers: ['workshop mod', 'mods installieren', 'mod installieren', '-mod=', '-servermod='],
    body: [
      'DayZ-Mods werden serverseitig ueber Startparameter wie `-mod=` geladen; typische Workshop-Mods enthalten Addons/Keys und ggf. Mod-Konfiguration.',
      'CE-Erweiterungen muessen nicht durch direktes Veraendern grosser Vanilla-Dateien erfolgen: Bohemia unterstuetzt zusaetzliche CE-Dateien ueber `<ce folder="...">` in `cfgeconomycore.xml`.',
      'Dabei sind CE-Dateitypen wie `types`, `spawnabletypes`, `globals`, `economy`, `events` und `messages` dokumentiert.',
      'Konkrete Mod-Pfade/Abhaengigkeiten nur aus der jeweiligen Mod-Dokumentation nennen; nicht erraten.',
    ].join('\n'),
  },
];

function normalize(s: string): string { return s.toLocaleLowerCase('de-DE'); }

function isNitradoSpecificQuestion(question: string): boolean {
  const q = normalize(question);
  return /\bnitrado\b/.test(q)
    || /konfigurationsdatei(en)?/.test(q)
    || /\bdateibrowser\b/.test(q)
    || /\bserverdz\.cfg\b/.test(q)
    || /\b(maxplayers|server(time|nighttime)acceleration)\b/.test(q)
    || /\bmission\s+(wechseln|ändern|aendern)\b/.test(q)
    || /\b(karte|map)\s+wechseln\b/.test(q)
    || /\bmods?\s+installieren\b/.test(q);
}

function findNitradoTopics(question: string): HelpTopic[] {
  const q = normalize(question);
  return NITRADO_TOPICS
    .map((topic) => ({ topic, score: topic.triggers.reduce((score, trigger) => score + (q.includes(normalize(trigger)) ? 1 : 0), 0) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => x.topic);
}

/** Avoids the old false positive where "Welcher Tag ist heute?" became DayZ help. */
export function isNitradoOrDayZHelpQuestion(question: string): boolean {
  if (!question) return false;
  if (isNitradoSpecificQuestion(question)) return true;
  if (buildDayzKnowledgeContext(question).found) return true;
  const q = normalize(question);
  return /\bdayz\b/.test(q) || /\bcentral economy\b/.test(q) || /\b(battleye|rcon)\b/.test(q);
}

/** Builds a focused, evidence-backed prompt block instead of a universal value table. */
export function lookupNitradoHelp(question: string): HelpAnswer {
  if (!question) return EMPTY;
  const dayz = buildDayzKnowledgeContext(question);
  const nitrado = findNitradoTopics(question);
  if (!dayz.found && nitrado.length === 0) return EMPTY;

  const lines: string[] = [];
  const ids: string[] = [];
  if (dayz.found) { lines.push(dayz.text); ids.push(...dayz.topicIds); }
  if (nitrado.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('NITRADO-BEDIENWEG (Hosting-Prozedur, nicht DayZ-Dateisemantik):');
    for (const topic of nitrado) {
      lines.push(`### ${topic.title}`, topic.body, '');
      ids.push(`nitrado:${topic.id}`);
    }
  }
  lines.push(
    'AUSGABEREGELN:',
    '- Keine Hostnames, IPs, Tokens, Service-IDs oder sonstige Server-Interna ausdenken.',
    '- Bei "unser Server / bei uns": konkrete Werte nur aus einer echten Serverdatei bzw. einem sicheren Server-Snapshot nennen.',
    '- Bei Kartenunterschieden die Karte benennen; niemals Chernarus-, Livonia- und Sakhal-Werte vermischen.',
    '- Fehlende Fakten offen als nicht belegt kennzeichnen statt plausibel klingend zu ergaenzen.',
  );
  return { text: lines.join('\n'), topicIds: [...new Set(ids)], found: true };
}

export function getDayZFileTruthBlock(): string { return getDayzGroundingTruthBlock(); }

export function looksLikeDayZFileQuestion(question: string): boolean {
  if (!question) return false;
  const q = normalize(question);
  if (/\b(types|events|globals|messages|economy)\.xml\b/.test(q)) return true;
  if (/\b(cfg[a-z0-9_]+|mapgroup[a-z0-9_]+|mapcluster[a-z0-9_]+)\.(xml|json)\b/.test(q)) return true;
  if (/\binit\.c\b|\bserverdz\.cfg\b/.test(q)) return true;
  if (/\bwelche\s+datei\b/.test(q) && /\b(dayz|loot|spawn|wetter|weather|tier|event|mission)\b/.test(q)) return true;
  if (/\bloot\b.*\b(haus|häuser|haeuser|gebäude|gebaeude)\b/.test(q)) return true;
  return false;
}

/** Legacy API: a numeric >25 rule is contradicted by the supplied 1.29 data. */
export function detectTypesXmlValueViolations(_text: string): string[] { return []; }

export interface SanitizeLootResult { text: string; changes: string[]; }

/**
 * Legacy API kept for compatibility. Never silently rewrites DayZ values.
 * Validation has to be file/map/context-aware; otherwise it becomes fabricated data.
 */
export function sanitizeDayZLootValues(text: string): SanitizeLootResult { return { text, changes: [] }; }

export function looksLikeDayZLootContent(text: string): boolean {
  if (!text) return false;
  return /\b(types\.xml|events\.xml|central economy|dayz|loot|nominal|restock|lifetime)\b/i.test(text)
    || /<(nominal|min|max|restock|lifetime)>/i.test(text)
    || /\b(nominal|min|max)\s*=\s*"\d+"/i.test(text);
}
