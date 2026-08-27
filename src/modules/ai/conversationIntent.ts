import { looksLikeLiveServerKnowledgeQuestion } from './dayzKnowledgeBoundary';
import { isDayzTechnicalAdminQuestion, looksLikeDayZFileQuestion } from './nitradoHelp';

/**
 * Harte Domain-Grenze fuer freie Discord-Konversation.
 *
 * Ziel: DayZ-/Nitrado-Wissen, Guild-Kontext und User-Profil duerfen nicht nur
 * deshalb in eine normale Frage geraten, weil im Channel kurz davor ueber
 * DayZ gesprochen wurde. Gleichzeitig muessen echte, sprachlich referentielle
 * Folgefragen den Kontext des unmittelbar vorherigen eigenen Dialogs behalten.
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

/**
 * Nur sprachlich eindeutige Folgefragen duerfen eine vorherige Domain erben.
 * Ein blosses "und" oder eine neue vollstaendige Sachfrage reicht absichtlich
 * nicht aus. So bleibt z.B. "Und was ist Photosynthese?" eine neue allgemeine
 * Frage und kann keinen alten DayZ-Kontext reaktivieren.
 */
export function looksLikeConversationFollowUp(question: string): boolean {
  const q = normalize(question)
    .replace(/[?!.,;:]+$/g, '')
    .trim();
  if (!q || q.length > 180) return false;

  if (/^(?:warum|wieso|weshalb|wie genau|was genau|und warum|und wieso|und weshalb|und wie genau|und was genau)$/.test(q)) {
    return true;
  }

  if (/\b(?:wie eben|wie gerade|wie oben|das eben|das gerade|deine antwort|deine letzte antwort|was du meinst|was meinst du damit|was ist damit|mehr dazu|noch mehr dazu|weiter dazu)\b/.test(q)) {
    return true;
  }

  if (/^(?:kannst du|koenntest du|konntest du|wuerdest du|wurdest du)\s+(?:das|es|dazu|darauf|damit)\b/.test(q)) {
    return true;
  }

  if (/^(?:und|aber|also|okay|ok|dann)\b.{0,110}\b(?:das|dazu|davon|damit|daran|dabei|darauf|es|so|weiter|mehr)\b/.test(q)) {
    return true;
  }

  return /^(?:das|dazu|davon|damit|daran|darauf|und das|und dazu|und davon|und damit|und weiter|weiter|mehr dazu)$/.test(q);
}

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

function areDomainsCompatible(current: AiConversationDomain, previous: AiConversationDomain): boolean {
  if (current === 'general') return previous === 'general';
  if (current === 'dayz') return previous === 'dayz';
  if (current === 'user_profile') return previous === 'user_profile' || previous === 'discord_server';
  return previous === 'discord_server' || previous === 'user_profile';
}

/**
 * Ermittelt fuer persistentes, bereits user/channel/guild-gescoptes Memory die
 * effektive Domain. Nur eine explizit referentielle Folgefrage darf die Domain
 * der letzten eigenen Nutzerfrage erben. Neue Sachfragen bleiben strikt bei
 * ihrer eigenen Klassifikation.
 */
export function resolveMemoryConversationDomain<T extends { role: 'user' | 'assistant'; content: string }>(
  question: string,
  turns: readonly T[],
): AiConversationDomain {
  const current = classifyAiConversationDomain(question);
  if (current !== 'general' || !looksLikeConversationFollowUp(question)) return current;

  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role !== 'user') continue;
    return classifyAiConversationDomain(turn.content);
  }
  return current;
}

/**
 * Einzelne Channel-Turns bleiben strikt anhand der aktuellen Frage gefiltert.
 * Anders als persistentes Memory ist der Channel-Verlauf nicht exklusiv auf
 * denselben Nutzer gescopet und darf deshalb keine Domain vererben.
 */
export function isMemoryTurnCompatible(question: string, turnText: string): boolean {
  const current = classifyAiConversationDomain(question);
  const previous = classifyAiConversationDomain(turnText);
  return areDomainsCompatible(current, previous);
}

/**
 * Filtert gespeicherte Dialoge paarweise anhand der Nutzerfrage, die eine
 * Assistentenantwort ausgeloest hat. Eine DayZ-Antwort kann sprachlich sehr
 * allgemein sein ("Das ist der Zielbestand") und waere bei isolierter
 * Textklassifikation faelschlich in spaeteren Smalltalk gelangt. Umgekehrt
 * bleibt eine normale Antwort erhalten, auch wenn sie das Wort DayZ nur als
 * Beispiel nennt.
 *
 * Bei einer eindeutig referentiellen Folgefrage darf die unmittelbar vorherige
 * eigene Dialog-Domain geerbt werden. Das Memory ist bereits auf exakt
 * userId/channelId/guildId begrenzt, daher oeffnet dies keine Channel-Grenze.
 */
export function filterCompatibleMemoryTurns<T extends { role: 'user' | 'assistant'; content: string }>(
  question: string,
  turns: readonly T[],
): T[] {
  const current = resolveMemoryConversationDomain(question, turns);
  let activePairCompatible: boolean | null = null;

  return turns.filter((turn) => {
    if (turn.role === 'user') {
      activePairCompatible = areDomainsCompatible(current, classifyAiConversationDomain(turn.content));
      return activePairCompatible;
    }
    if (activePairCompatible !== null) return activePairCompatible;
    return areDomainsCompatible(current, classifyAiConversationDomain(turn.content));
  });
}

/**
 * Externer Server-/Channel-Kontext ist bei normalen Fragen tabu. Fuer die drei
 * expliziten Kontextdomains bleibt er zulaessig. Persistentes Conversation-
 * Memory wird separat behandelt und kann sichere referentielle Follow-ups
 * innerhalb seines user/channel/guild-Scopes aufloesen.
 */
export function mayUseExternalConversationContext(question: string): boolean {
  return classifyAiConversationDomain(question) !== 'general';
}
