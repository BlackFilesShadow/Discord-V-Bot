import * as prior from './dayz129CatalogPriorityV2';
import * as base from './dayz129CatalogBase';
import type { DayzCatalogAnswer } from './dayz129CatalogBase';

type Resolution = { matched: boolean; candidates: string[] };

const DISPLAY_ALIASES: Readonly<Record<string, string>> = {
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

const COLOR_SUFFIXES = new Set([
  'black', 'blue', 'brown', 'green', 'grey', 'gray', 'red', 'orange', 'yellow', 'pink', 'white',
  'beige', 'olive', 'tan', 'khaki', 'camo', 'dpm', 'flecktarn', 'ttsko',
]);

const COLOR_WORDS: ReadonlyArray<{ re: RegExp; suffixes: string[] }> = [
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

function fold(text: string): string {
  return text.toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function compact(text: string): string { return fold(text).replace(/[^a-z0-9]+/g, ''); }

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row++) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column++) {
      const above = previous[column];
      previous[column] = Math.min(
        above + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function cleanLookupText(question: string): string {
  return fold(question)
    .replace(/\b(?:db\/)?types?\.xml\b/g, ' ')
    .replace(/\b(?:classname|class name|typename|type name|itemname|item name)\b/g, ' ')
    .replace(/\b(?:kannst|koenntest|könntest|hast|weisst|weißt|weiss|weiß|sag|sagen|nenn|nennen|bitte|mir|du|ich|meine|von|vom|der|die|das|den|dem|des|einer|einem|eine|einen|waffe|item|gegenstand|dayz|heisst|heißt|wie|in)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function explicitLookupIntent(question: string): boolean {
  const q = fold(question);
  return /\b(classname|class name|typename|type name|itemname|item name)\b/.test(q)
    || (/\btypes?\.xml\b/.test(q) && /\b(wie|name|heisst)\b/.test(q));
}

function exactIndexedMention(question: string): string | null {
  if (!explicitLookupIntent(question)) return null;
  const q = fold(question);
  const names = [...base.getDayz129Index().allTypeNames]
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return names.find((name) => q.includes(fold(name))) ?? null;
}

function isShortItemFollowUp(question: string): boolean {
  const q = fold(question);
  if (/\b(?:was|warum|wo|wann|erklaer|funktioniert|werte?|stats?|schaden|damage|reichweite|nominal|min|max|lifetime|restock|usage|tier|spawn|magazin|munition|ammo|kaliber|attachment|zubehoer|zubehör)\b/.test(q)) return false;
  const cleaned = cleanLookupText(question);
  const words = cleaned.split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 3;
}

function splitColor(name: string): { baseName: string; color: string | null } {
  const parts = name.split('_');
  if (parts.length < 2) return { baseName: name, color: null };
  const last = fold(parts[parts.length - 1]);
  if (!COLOR_SUFFIXES.has(last)) return { baseName: name, color: null };
  return { baseName: parts.slice(0, -1).join('_'), color: last };
}

function requestedColors(question: string): string[] {
  const q = fold(question);
  return COLOR_WORDS.find((x) => x.re.test(q))?.suffixes ?? [];
}

function withoutColorWords(cleaned: string): string {
  return compact(cleaned.replace(/\b(?:gruen|green|schwarz|black|braun|brown|grau|grey|gray|blau|blue|rot|red|orange|gelb|yellow|rosa|pink|weiss|white|beige|oliv|olive|khaki|tan|camo|tarn|tarnung)\b/gi, ' '));
}

/**
 * Alias-Ranking: exakt vor konservativer Tippfehlerstufe. Die Fuzzy-Stufe ist
 * absichtlich nur fuer mindestens sechs Zeichen und genau eine Edit-Operation
 * aktiv. Mehrere gleich gute Ziel-Classnames bedeuten Ambiguitaet und liefern
 * keinen Treffer; insbesondere darf ein kurzer Begriff wie "AK" nie geraten
 * werden.
 */
function resolveAlias(query: string): string | null {
  const exact = DISPLAY_ALIASES[query];
  if (exact) return exact;
  if (query.length < 6) return null;

  const ranked = Object.entries(DISPLAY_ALIASES)
    .map(([alias, target]) => ({ target, distance: editDistance(query, alias) }))
    .filter(candidate => candidate.distance <= 1)
    .sort((a, b) => a.distance - b.distance || a.target.localeCompare(b.target));
  if (!ranked.length) return null;
  const bestDistance = ranked[0].distance;
  const bestTargets = Array.from(new Set(
    ranked.filter(candidate => candidate.distance === bestDistance).map(candidate => candidate.target),
  ));
  return bestTargets.length === 1 ? bestTargets[0] : null;
}

function exactKnown(cleaned: string): string | null {
  const direct = base.getDayz129Index().allTypeNames.filter((name) => fold(name) === fold(cleaned));
  if (direct.length === 1) return direct[0];
  const q = compact(cleaned);
  if (!q) return null;
  const exact = base.getDayz129Index().allTypeNames.filter((name) => compact(name) === q);
  return exact.length === 1 ? exact[0] : null;
}

function familyCandidates(baseName: string, colors: string[]): string[] {
  const wanted = compact(baseName);
  const out = base.getDayz129Index().allTypeNames.filter((name) => {
    const split = splitColor(name);
    if (!split.color || compact(split.baseName) !== wanted) return false;
    return colors.length === 0 || colors.includes(split.color);
  });
  return out.sort((a, b) => a.localeCompare(b));
}

function strongPrefixCandidate(cleaned: string): string | null {
  const q = compact(cleaned);
  if (q.length < 3) return null;
  const matches = base.getDayz129Index().allTypeNames
    .filter((name) => compact(name).startsWith(q))
    .sort((a, b) => compact(a).length - compact(b).length || a.localeCompare(b));
  if (!matches.length) return null;
  const firstLen = compact(matches[0]).length;
  if (firstLen > q.length + 6) return null;
  if (matches.length === 1) return matches[0];
  const secondLen = compact(matches[1]).length;
  return secondLen - firstLen >= 3 ? matches[0] : null;
}

/**
 * Vollindex-Fallback fuer natuerliche englische/technische Bezeichnungen.
 * Anders als die historische Handvoll DISPLAY_ALIASES arbeitet dieser Pfad
 * ueber ALLE Classnames der eingebetteten types.xml-Datensaetze. Er bleibt
 * fail-closed: kurze/mehrdeutige Fragmente wie "AK" werden niemals geraten.
 */
function fullIndexCandidates(cleaned: string): string[] {
  const query = compact(cleaned);
  if (query.length < 4) return [];
  const names = base.getDayz129Index().allTypeNames;

  const prefixFamily = names
    .filter(name => compact(name).startsWith(query))
    .sort((a, b) => compact(a).length - compact(b).length || a.localeCompare(b));
  if (prefixFamily.length > 0 && prefixFamily.length <= 25) return prefixFamily;

  const queryTokens = fold(cleaned).split(/[^a-z0-9]+/).filter(token => token.length >= 3);
  if (queryTokens.length === 0) return [];
  const ranked = names.map((name) => {
    const source = name
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ');
    // Kurze technische Fragmente sind nicht semantisch. Insbesondere darf das
    // einzelne "K" aus MP5K nicht zu jedem deutschen Wort mit K passen.
    const tokens = fold(source).split(/[^a-z0-9]+/).filter(token => token.length >= 3);
    let score = 0;
    for (const q of queryTokens) {
      const exact = tokens.some(token => token === q);
      const prefix = tokens.some(token => token.startsWith(q) || q.startsWith(token));
      const contains = tokens.some(token => token.includes(q) || q.includes(token));
      if (exact) score += 4;
      else if (prefix) score += 2;
      else if (contains && q.length >= 5) score += 1;
      else return { name, score: -1 };
    }
    if (compact(name).includes(query)) score += 3;
    return { name, score };
  }).filter(row => row.score > 0)
    .sort((a, b) => b.score - a.score || compact(a.name).length - compact(b.name).length || a.name.localeCompare(b.name));

  if (ranked.length === 0) return [];
  const best = ranked[0].score;
  const strong = ranked.filter(row => row.score >= Math.max(best - 1, queryTokens.length * 2));
  if (strong.length === 1) return [strong[0].name];
  return strong.length <= 25 ? strong.map(row => row.name) : [];
}

function resolve(question: string): Resolution {
  const cleaned = cleanLookupText(question);
  if (!cleaned) return { matched: false, candidates: [] };

  const exact = exactKnown(cleaned);
  if (exact) return { matched: true, candidates: [exact] };

  const cleanedCompact = compact(cleaned);
  const colorTokens = requestedColors(cleaned);
  const aliasQuery = colorTokens.length > 0 ? withoutColorWords(cleaned) : cleanedCompact;
  const aliasTarget = resolveAlias(aliasQuery);
  if (aliasTarget) {
    const target = aliasTarget;
    if (base.isKnownDayz129Identifier(target) && colorTokens.length === 0) return { matched: true, candidates: [target] };
    const family = familyCandidates(target, colorTokens);
    if (family.length) return { matched: true, candidates: family };
  }

  const families = new Map<string, string>();
  for (const name of base.getDayz129Index().allTypeNames) {
    const split = splitColor(name);
    if (split.color) families.set(compact(split.baseName), split.baseName);
  }
  const queryWithoutColor = colorTokens.length ? withoutColorWords(cleaned) : cleanedCompact;
  const familyBase = families.get(queryWithoutColor);
  if (familyBase) {
    const variants = familyCandidates(familyBase, colorTokens);
    if (variants.length) return { matched: true, candidates: variants };
  }

  const prefix = strongPrefixCandidate(cleaned);
  if (prefix) return { matched: true, candidates: [prefix] };

  const fullIndex = fullIndexCandidates(cleaned);
  if (fullIndex.length) return { matched: true, candidates: fullIndex };

  return { matched: false, candidates: [] };
}

function answerFor(candidates: string[]): DayzCatalogAnswer {
  if (candidates.length === 1) {
    const name = candidates[0];
    return { answer: `Der Classname ist **\`${name}\`**.`, topic: 'type', ids: [`dayz129:type:${name}`] };
  }
  return {
    answer: ['Ich finde mehrere passende Classnames:', ...candidates.map((name) => `- \`${name}\``), '', 'Welchen davon meinst du?'].join('\n'),
    topic: 'type-search',
    ids: candidates.map((name) => `dayz129:type:${name}`),
  };
}

export function searchTypes(query: string, limit = 5): string[] {
  if (limit <= 0) return [];
  const strict = resolve(query);
  return strict.matched ? strict.candidates.slice(0, limit) : prior.searchTypes(query, limit);
}

export function answer(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const explicit = explicitLookupIntent(question);
  const shortFollowUp = isShortItemFollowUp(question);

  if (explicit) {
    const exact = exactIndexedMention(question);
    if (exact) return answerFor([exact]);
  }

  if (explicit || shortFollowUp) {
    const strict = resolve(question);
    if (strict.matched) return answerFor(strict.candidates);
    if (explicit) {
      return {
        answer: 'Dazu finde ich im realen DayZ-1.29-`types.xml`-Index keinen eindeutig passenden Classname. Ich rate keinen Namen.',
        topic: 'type-search',
        ids: ['dayz129:type:not-found'],
      };
    }
  }

  return prior.answer(question);
}
