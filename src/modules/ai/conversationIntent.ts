import { looksLikeLiveServerKnowledgeQuestion } from './dayzKnowledgeBoundary';
import { isDayzTechnicalAdminQuestion, looksLikeDayZFileQuestion } from './nitradoHelp';

/**
 * Harte Domain-Grenze fuer freie Discord-Konversation.
 *
 * Ziel: DayZ-/Nitrado-Wissen, Guild-Kontext und User-Profil duerfen nicht nur
 * deshalb in eine normale Frage geraten, weil im Channel kurz davor ueber
 * DayZ gesprochen wurde. Die aktuelle Nutzerfrage entscheidet die Domain.
 */
export type AiConversationDomain = 'general' | 'dayz' | 'discord_server' | 'user_profile';

function normalize(value: string): string {
  return String(value || '')
    .toLocaleLowerCase('de-DE')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STRONG_DAYZ_RE = /\b(?:dayz|nitrado|chernarus|livonia|enoch|sakhal|central economy|serverdz\.cfg|cfggameplay\.json|cfgeventspawns\.xml|types\.xml|events\.xml|globals\.xml|economy\.xml|messages\.xml|init\.c|classname|class name|basebuilding|build anywhere|adm[- ]?log|izurvive|lifetime|restock|nominal)\b/i;
const DAYZ_GAMEPLAY_RE = /\b(?:loot|spawn|spawns|infected|zombies?|heli(?:crash)?|wipe|whitelist)\b/i;
const DAYZ_TECH_CONTEXT_RE = /\b(?:xml|json|cfg|config|konfig|mission|server|gameserver|datei|event|economy|ce)\b/i;

const USER_PROFILE_RE = /\b(?:mein(?:e|en|em|er)?\s+(?:level|xp|rolle|rollen|nickname|beitrittsdatum|aktivitat|aktivitaet|nachrichten)|wann\s+bin\s+ich\s+(?:diesem|dem|auf\s+dem)\s+server\s+beigetreten|seit\s+wann\s+bin\s+ich\s+(?:hier|auf\s+dem\s+server))\b/i;
const DISCORD_SERVER_RE = /\b(?:discord[- ]?server|serverregeln|regelwerk|welche\s+regeln|welche\s+kanale|welche\s+kanaele|welche\s+channels|welche\s+rollen|mitglieder(?:zahl)?|boost(?:s|[- ]?level)?|server[- ]?owner|owner\s+des\s+servers|status\s+vom\s+server|server[- ]?status)\b/i;

export function classifyAiConversationDomain(question: string): AiConversationDomain {
  const q = normalize(question);
  if (!q) return 'general';

  // Bestehende DayZ-Grenzen bleiben kanonisch. Damit werden auch Live-Fragen
  // wie "wie ist unser nominal?" korrekt DayZ zugeordnet, selbst wenn "DayZ"
  // nicht noch einmal ausgeschrieben wurde.
  if (looksLikeLiveServerKnowledgeQuestion(question)
    || isDayzTechnicalAdminQuestion(question)
    || looksLikeDayZFileQuestion(question)
    || STRONG_DAYZ_RE.test(q)
    || (DAYZ_GAMEPLAY_RE.test(q) && DAYZ_TECH_CONTEXT_RE.test(q))) {
    return 'dayz';
  }

  if (USER_PROFILE_RE.test(q)) return 'user_profile';
  if (DISCORD_SERVER_RE.test(q)) return 'discord_server';
  return 'general';
}

export function isDayzConversationDomain(question: string): boolean {
  return classifyAiConversationDomain(question) === 'dayz';
}

/**
 * Memory ist nur innerhalb derselben Domain zulaessig. So kann eine alte
 * DayZ-Antwort niemals eine spaetere normale Wissens-/Smalltalkfrage steuern.
 */
export function isMemoryTurnCompatible(question: string, turnText: string): boolean {
  const current = classifyAiConversationDomain(question);
  const previous = classifyAiConversationDomain(turnText);
  if (current === 'general') return previous === 'general';
  if (current === 'dayz') return previous === 'dayz';
  if (current === 'user_profile') return previous === 'user_profile' || previous === 'discord_server';
  return previous === 'discord_server' || previous === 'user_profile';
}

/**
 * Externer Server-/Channel-Kontext ist bei normalen Fragen tabu. Fuer die drei
 * expliziten Kontextdomains bleibt er zulaessig.
 */
export function mayUseExternalConversationContext(question: string): boolean {
  return classifyAiConversationDomain(question) !== 'general';
}
