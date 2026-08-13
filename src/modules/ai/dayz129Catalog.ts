import * as core from './dayz129CatalogCore';

export type { Dayz129Map, Dayz129Index, DayzCatalogAnswer } from './dayz129CatalogCore';
export {
  DAYZ129_PROVENANCE,
  getDayz129Index,
  searchDayz129Types,
  searchDayz129Events,
  isKnownDayz129Identifier,
  enrichDayz129FollowUp,
  getDayz129CatalogStats,
} from './dayz129CatalogCore';

/**
 * Public catalog facade.
 *
 * Normalizes singular legacy file aliases before intent routing so an explicit
 * filename such as `Event.xml` cannot be mistaken for an event-name lookup.
 */
export function answerDayz129CatalogQuestion(question: string): core.DayzCatalogAnswer | null {
  const normalized = question.replace(/\bevent\.xml\b/gi, 'events.xml');
  return core.answerDayz129CatalogQuestion(normalized);
}
