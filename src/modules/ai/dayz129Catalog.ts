import type { DayzCatalogAnswer } from './dayz129CatalogBase';
import {
  enrichDayz129FollowUp as enrichDayz129FollowUpBase,
  isKnownDayz129Identifier,
} from './dayz129CatalogBase';
import { answer as answerGeneralDayz129Question, searchTypes } from './dayz129CatalogPriorityV4';
import { looksLikeLiveServerKnowledgeQuestion } from './dayzKnowledgeBoundary';

export {
  DAYZ129_PROVENANCE,
  getDayz129Index,
  searchDayz129Events,
  isKnownDayz129Identifier,
  getDayz129CatalogStats,
} from './dayz129CatalogBase';
export type { Dayz129Map, Dayz129Index, DayzCatalogAnswer } from './dayz129CatalogBase';

export {
  DAYZ_KNOWLEDGE_PLATFORMS,
  computeDayzKnowledgeManifestSha256,
  getDayz129CatalogPlatform,
  getDayz129FileMetadata,
  getDayz129KnowledgeManifest,
  validateDayzKnowledgeIndex,
} from './dayzKnowledgeManifest';
export type {
  DayzKnowledgeFileMetadata,
  DayzKnowledgeManifest,
  DayzKnowledgePlatform,
  DayzKnowledgeValidationIssue,
  DayzKnowledgeValidity,
} from './dayzKnowledgeManifest';

export { searchTypes as searchDayz129Types };

const KNOWN_DAYZ_FILE_ALIASES_RE = /\b(?:types?|events?|messages?|globals?)\.xml\b|\beconomy\.xml\b|\bserverdz\.cfg\b|\bcfggameplay\.json\b/i;
const VERIFIED_NATURAL_DAYZ_ALIAS_RE = /\b(?:m4|tundra|kampfstiefel|kampfanzugs?hose|kampfhose|combat\s*pants|bduhose|bdu\s*pants|feldrucks(?:ack|aecke)|alicebag|seekiste|sea\s+chest|strom[-_ ]?generator|militaerzelt|militärzelt|military\s*tent|largetent)\b/i;
const STRONG_CE_TERM_RE = /\b(?:restock|nominal|quantmin|quantmax|count_in_(?:cargo|hoarder|map|player)|deloot|crafted)\b/i;

function looksTechnicalIdentifier(token: string): boolean {
  return /[0-9_.-]/.test(token)
    || /[a-z][A-Z]/.test(token)
    || /^[A-Z0-9_]{3,}$/.test(token);
}

function hasKnownTechnicalIdentifier(question: string): boolean {
  const tokens = String(question || '').match(/[A-Za-z0-9_.-]{2,128}/g) ?? [];
  return tokens.some(token => looksTechnicalIdentifier(token) && isKnownDayz129Identifier(token));
}

function explicitCatalogIntent(question: string): boolean {
  const q = String(question || '').normalize('NFKC').trim();
  if (!q) return false;
  if (/\b(?:dayz|classname|class name|typename|type name|itemname|item name|eventname|event name)\b/i.test(q)
    || KNOWN_DAYZ_FILE_ALIASES_RE.test(q)
    || VERIFIED_NATURAL_DAYZ_ALIAS_RE.test(q)
    || STRONG_CE_TERM_RE.test(q)) {
    return true;
  }

  // Reale technische Identifier wie WoodenPlank, M4A1 oder StaticHeliCrash
  // bleiben auch ohne ausgeschriebenes "DayZ" nutzbar. Normale Woerter wie
  // "Apple" reichen bewusst nicht, obwohl sie zufaellig ein DayZ-Typ sein koennen.
  return hasKnownTechnicalIdentifier(q);
}

function looksReferentialFollowUp(question: string): boolean {
  const q = String(question || '').normalize('NFKC').trim().toLocaleLowerCase('de-DE');
  if (!q || q.length > 160) return false;
  return /^(?:und\s+)?(?:wie\s+genau|warum(?:\s+das)?|was\s+bedeutet\s+(?:das|der\s+wert)|was\s+heisst\s+das|was\s+heißt\s+das|zeig(?:e)?\s+(?:mir\s+)?(?:ein\s+)?beispiel|nochmal|dazu|welcher\s+wert|welche\s+werte|auf\s+(?:chernarus|livonia|sakhal)|und\s+wie|und\s+was)\b/.test(q)
    || /\b(?:das|dazu|davon|darin|dieser|diese|dieses|der\s+wert|die\s+werte)\b/.test(q);
}

/**
 * Nur echte referenzielle Folgefragen duerfen aus einer vorherigen DayZ-Antwort
 * mit Classname/Event/Datei angereichert werden. Breite generische
 * Hilfsformulierungen reichen nicht mehr aus und koennen keine neue allgemeine
 * Frage versehentlich in die DayZ-Domain ziehen.
 */
export function enrichDayz129FollowUp(question: string, previousAssistantText?: string | null): string {
  if (!looksReferentialFollowUp(question)) return question;
  return enrichDayz129FollowUpBase(question, previousAssistantText);
}

/**
 * AI-13 Boundary: Der eingebettete 1.29-Katalog ist ausschliesslich allgemeine
 * DayZ-/Vanilla-Referenz. Sobald die Frage den realen Zustand des eigenen
 * Gameservers meint, darf dieser Preflight keine Vanilla-Werte als Live-Werte
 * ausgeben; die Anfrage muss in den servergescoppten Knowledge-Pfad weiterlaufen.
 *
 * Zusaetzlich darf der Katalog keine allgemeine Frage mehr "kapern". Deshalb
 * braucht ein ungescopter Katalog-Lookup jetzt einen expliziten DayZ-/Catalog-
 * Marker, einen verifizierten DayZ-Alias/Fachbegriff oder einen eindeutig
 * technischen, realen Identifier.
 */
export function answerDayz129CatalogQuestion(question: string): DayzCatalogAnswer | null {
  if (looksLikeLiveServerKnowledgeQuestion(question)) return null;
  if (!explicitCatalogIntent(question)) return null;
  return answerGeneralDayz129Question(question);
}
