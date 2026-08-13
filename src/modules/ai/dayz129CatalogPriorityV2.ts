import * as prior from './dayz129CatalogPriority';
import * as base from './dayz129CatalogBase';
import type { DayzCatalogAnswer } from './dayz129CatalogBase';

type Resolution = { matched: boolean; candidates: string[] };

type Family = { re: RegExp; prefix: string };
const FAMILIES: readonly Family[] = [
  { re: /\b(?:kampfstiefel|combat\s*boots?|combatboots)\b/i, prefix: 'CombatBoots_' },
  { re: /\b(?:feldrucksack|alice\s*bag|alicebag)\b/i, prefix: 'AliceBag_' },
];

const COLORS: ReadonlyArray<{ re: RegExp; suffix: string }> = [
  { re: /\b(?:gruen|green)\b/i, suffix: 'Green' },
  { re: /\b(?:schwarz|black)\b/i, suffix: 'Black' },
  { re: /\b(?:braun|brown)\b/i, suffix: 'Brown' },
  { re: /\b(?:grau|grey|gray)\b/i, suffix: 'Grey' },
  { re: /\bbeige\b/i, suffix: 'Beige' },
  { re: /\b(?:camo|tarn|tarnung)\b/i, suffix: 'Camo' },
];

function fold(text: string): string {
  return text.toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function resolve(question: string): Resolution {
  const q = fold(question);
  const family = FAMILIES.find((x) => x.re.test(q));
  if (!family) return { matched: false, candidates: [] };

  let candidates = base.getDayz129Index().allTypeNames
    .filter((name) => name.startsWith(family.prefix))
    .filter((name) => base.isKnownDayz129Identifier(name))
    .sort((a, b) => a.localeCompare(b));

  const color = COLORS.find((x) => x.re.test(q));
  if (color) {
    const suffix = `_${color.suffix}`.toLowerCase();
    candidates = candidates.filter((name) => name.toLowerCase().endsWith(suffix));
  }
  return { matched: true, candidates };
}

function isLookup(question: string): boolean {
  const q = fold(question);
  return /\b(classname|class name|typename|type name|itemname|item name)\b/.test(q)
    || (/\btypes?\.xml\b/.test(q) && /\b(wie|name|heisst)\b/.test(q));
}

function isShortLookup(question: string): boolean {
  const q = fold(question).trim();
  if (/\b(?:was|warum|wo|wann|erklaer|funktioniert)\b/.test(q)) return false;
  return q.split(/\s+/).filter(Boolean).length <= 4;
}

function answerFor(r: Resolution): DayzCatalogAnswer {
  if (r.candidates.length === 1) {
    const name = r.candidates[0];
    return { answer: `Der Classname ist **\`${name}\`**.`, topic: 'type', ids: [`dayz129:type:${name}`] };
  }
  if (r.candidates.length > 1) {
    return {
      answer: ['Ich finde mehrere passende Classnames:', ...r.candidates.map((n) => `- \`${n}\``), '', 'Welchen davon meinst du?'].join('\n'),
      topic: 'type-search',
      ids: r.candidates.map((n) => `dayz129:type:${n}`),
    };
  }
  return {
    answer: 'Dazu finde ich im realen 1.29-Index keine passende Farbvariante. Ich rate keinen Classname.',
    topic: 'type-search', ids: ['dayz129:type:not-found'],
  };
}

export function searchTypes(query: string, limit = 5): string[] {
  if (limit <= 0) return [];
  const r = resolve(query);
  return r.matched ? r.candidates.slice(0, limit) : prior.searchTypes(query, limit);
}

export function answer(question: string): DayzCatalogAnswer | null {
  if (!question) return null;
  const native = prior.answer(question);
  if (native?.topic === 'type' || native?.topic === 'event') return native;

  const r = resolve(question);
  if (r.matched && (isLookup(question) || isShortLookup(question))) return answerFor(r);
  return native;
}
