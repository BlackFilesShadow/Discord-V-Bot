import type { DayzCatalogAnswer } from './dayz129CatalogBase';
import {
  isKnownDayz129Identifier,
} from './dayz129CatalogBase';
import { answer as answerGeneralDayz129Question, searchTypes } from './dayz129CatalogPriorityV4';
import { looksLikeLiveServerKnowledgeQuestion } from './dayzKnowledgeBoundary';

export {
  DAYZ129_PROVENANCE,
  getDayz129Index,
  searchDayz129Events,
  isKnownDayz129Identifier,
  enrichDayz129FollowUp,
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

function explicitCatalogIntent(question: string): boolean {
  const q = String(question || '').normalize('NFKC').trim();
  if (!q) return false;
  if (/\b(?:dayz|classname|class name|typename|type name|itemname|item name|eventname|event name|types?\.xml|events?\.xml|serverdz\.cfg|cfggameplay\.json)\b/i.test(q)) {
    return true;
  }

  // Ein alleinstehender, technisch aussehender Identifier darf weiterhin direkt
  // aufgeloest werden. Normale Woerter wie "Apple" oder "Jacke" reichen bewusst
  // nicht mehr aus, weil sie auch ausserhalb von DayZ vorkommen koennen.
  if (/^[A-Za-z0-9_.-]{2,128}$/.test(q)
    && (/[0-9_.-]/.test(q) || /^[A-Z0-9_]{3,}$/.test(q))
    && isKnownDayz129Identifier(q)) {
    return true;
  }
  return false;
}

/**
 * AI-13 Boundary: Der eingebettete 1.29-Katalog ist ausschliesslich allgemeine
 * DayZ-/Vanilla-Referenz. Sobald die Frage den realen Zustand des eigenen
 * Gameservers meint, darf dieser Preflight keine Vanilla-Werte als Live-Werte
 * ausgeben; die Anfrage muss in den servergescoppten Knowledge-Pfad weiterlaufen.
 *
 * Zusaetzlich darf der Katalog keine allgemeine Frage mehr "kapern". Deshalb
 * braucht ein ungescopter Katalog-Lookup jetzt einen expliziten DayZ-/Catalog-
 * Marker oder einen eindeutig technischen, realen Identifier.
 */
export function answerDayz129CatalogQuestion(question: string): DayzCatalogAnswer | null {
  if (looksLikeLiveServerKnowledgeQuestion(question)) return null;
  if (!explicitCatalogIntent(question)) return null;
  return answerGeneralDayz129Question(question);
}
