import * as v3 from './dayz129CatalogPriorityV3';
import * as base from './dayz129CatalogBase';
import type { DayzCatalogAnswer } from './dayz129CatalogBase';

function fold(text: string): string {
  return text.toLocaleLowerCase('de-DE')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function explicitLookupIntent(question: string): boolean {
  const q = fold(question);
  return /\b(classname|class name|typename|type name|itemname|item name)\b/.test(q)
    || (/\btypes?\.xml\b/.test(q) && /\b(wie|name|heisst)\b/.test(q));
}

function hasDetailIntent(question: string): boolean {
  return /\b(?:werte?|stats?|schaden|damage|reichweite|nominal|min|max|lifetime|restock|usage|tier|spawn|magazin|munition|ammo|kaliber|attachment|zubehoer|zubehör|erklaer|erklär|funktioniert)\b/i.test(fold(question));
}

function exactCaseMention(question: string): string | null {
  const names = [...base.getDayz129Index().allTypeNames]
    .sort((a, b) => b.length - a.length || a.localeCompare(b));
  return names.find((name) => question.includes(name)) ?? null;
}

function uniqueCaseInsensitiveMention(question: string): string | null {
  const q = fold(question);
  const matches = base.getDayz129Index().allTypeNames.filter((name) => q.includes(fold(name)));
  return matches.length === 1 ? matches[0] : null;
}

function exactAnswer(name: string): DayzCatalogAnswer {
  return {
    answer: `Der Classname ist **\`${name}\`**.`,
    topic: 'type',
    ids: [`dayz129:type:${name}`],
  };
}

export const searchTypes = v3.searchTypes;

export function answer(question: string): DayzCatalogAnswer | null {
  if (!question) return null;

  const explicit = explicitLookupIntent(question);
  const short = question.trim().split(/\s+/).filter(Boolean).length <= 6 && !hasDetailIntent(question);

  if (explicit || short) {
    const exact = exactCaseMention(question);
    if (exact) return exactAnswer(exact);
  }

  // Case-insensitive matching is allowed only for explicit classname requests
  // and only when it is unique. This deliberately refuses collisions such as
  // Ammo_40mm_ChemGas vs Ammo_40mm_Chemgas instead of returning the wrong one.
  if (explicit) {
    const unique = uniqueCaseInsensitiveMention(question);
    if (unique) return exactAnswer(unique);
  }

  return v3.answer(question);
}
