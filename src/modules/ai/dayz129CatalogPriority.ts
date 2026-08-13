import * as base from './dayz129CatalogBase';
import type { DayzCatalogAnswer } from './dayz129CatalogBase';

const TYPE_DISPLAY_ALIASES: ReadonlyArray<{ re: RegExp; classname: string }> = [
  { re: /\btundra\b/i, classname: 'Winchester70' },
];

function fold(text: string): string {
  return text
    .toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function resolveDisplayAlias(question: string): string | null {
  for (const entry of TYPE_DISPLAY_ALIASES) {
    if (entry.re.test(question) && base.isKnownDayz129Identifier(entry.classname)) return entry.classname;
  }
  return null;
}

function isHumanTypeNameLookup(question: string): boolean {
  const q = fold(question);
  const explicitClassname = /\b(classname|class name|typename|type name|itemname|item name)\b/.test(q);
  const typesXmlNameQuestion = /\btypes?\.xml\b/.test(q)
    && (/\bwie\b.{0,120}\b(heisst|heißt)\b/.test(q) || /\bname\b/.test(q));
  return explicitClassname || typesXmlNameQuestion;
}

function cleanTypeLookupQuery(question: string): string {
  return question
    .replace(/\b(?:db\/)?types?\.xml\b/gi, ' ')
    .replace(/\b(?:classname|class name|typename|type name|itemname|item name)\b/gi, ' ')
    .replace(/\b(?:weisst|weißt|weiss|weiß|du|mir|bitte|wie|heisst|heißt|der|die|das|den|dem|von|in)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function conciseTypeAnswer(classname: string): DayzCatalogAnswer {
  return {
    answer: `Der Classname ist **\`${classname}\`**.`,
    topic: 'type',
    ids: [`dayz129:type:${classname}`],
  };
}

function conciseTypeCandidates(candidates: string[]): DayzCatalogAnswer {
  return {
    answer: [
      'Ich finde mehrere passende Classnames:',
      ...candidates.map((name) => `- \`${name}\``),
      '',
      'Welchen davon meinst du?',
    ].join('\n'),
    topic: 'type-search',
    ids: candidates.map((name) => `dayz129:type:${name}`),
  };
}

function isRestockDefinitionQuestion(question: string): boolean {
  const q = fold(question);
  if (!/\brestock\b/.test(q)) return false;
  return /\b(was|bedeutet|bedeutung|erklaer|erklär|funktioniert|wofuer|wofür)\b/.test(q)
    || /^\s*restock\s*[?!.]*\s*$/.test(q);
}

function restockAnswer(question: string): DayzCatalogAnswer {
  const q = fold(question);
  const eventContext = /\bevents?\.xml\b|\bevent\b/.test(q);
  const answer = eventContext
    ? '`restock` ist in `events.xml` ein Zeitwert in **Sekunden** fuer die zeitliche Wiederauffuellung eines Events bzw. das Nachspawnen einzelner Event-Entities. Er ist kein fester Timer fuer einen bestimmten Welt-Spawnpunkt.'
    : '`restock` ist in `types.xml` ein Zeitwert der **Central Economy in Sekunden**, der bei der Wiederauffuellungs-/Respawn-Logik dieses Typs verwendet wird. Er bedeutet **nicht**, dass genau derselbe Spawnpunkt nach dieser Zeit garantiert wieder ein Item bekommt.';
  return { answer, topic: 'file', ids: ['dayz129:field:restock'] };
}

export function searchTypes(query: string, limit = 5): string[] {
  const alias = resolveDisplayAlias(query);
  if (alias) return limit > 0 ? [alias] : [];
  return base.searchDayz129Types(query, limit);
}

export function answer(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  if (isRestockDefinitionQuestion(question)) return restockAnswer(question);

  const native = base.answerDayz129CatalogQuestion(question);
  if (native?.topic === 'type' || native?.topic === 'event') return native;

  if (isHumanTypeNameLookup(question)) {
    const alias = resolveDisplayAlias(question);
    if (alias) return conciseTypeAnswer(alias);

    const candidates = base.searchDayz129Types(cleanTypeLookupQuery(question), 5);
    if (candidates.length === 1) return conciseTypeAnswer(candidates[0]);
    if (candidates.length > 1) return conciseTypeCandidates(candidates);
    return {
      answer: 'Dazu finde ich keinen passenden Classname. Beschreibe den Gegenstand etwas genauer.',
      topic: 'type-search',
      ids: ['dayz129:type:not-found'],
    };
  }

  return native;
}
