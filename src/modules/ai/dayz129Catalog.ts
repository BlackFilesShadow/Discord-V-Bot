import type { DayzCatalogAnswer } from './dayz129CatalogBase';
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

/**
 * AI-13 Boundary: Der eingebettete 1.29-Katalog ist ausschliesslich allgemeine
 * DayZ-/Vanilla-Referenz. Sobald die Frage den realen Zustand des eigenen
 * Gameservers meint, darf dieser Preflight keine Vanilla-Werte als Live-Werte
 * ausgeben; die Anfrage muss in den servergescoppten Knowledge-Pfad weiterlaufen.
 */
export function answerDayz129CatalogQuestion(question: string): DayzCatalogAnswer | null {
  if (looksLikeLiveServerKnowledgeQuestion(question)) return null;
  return answerGeneralDayz129Question(question);
}
