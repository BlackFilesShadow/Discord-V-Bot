/**
 * Revision VI / MSG-ACT: zentrale Aktivierungsentscheidung fuer AI und Trigger.
 *
 * Sicherheits-/UX-Doktrin:
 * - allgemeine AI antwortet nur auf echte Bot-Mention, Reply auf den Bot oder
 *   den expliziten /ai-Command;
 * - gespeicherte Trigger sind standardmaessig MENTION_ONLY;
 * - passives Feuern muss pro Trigger explizit mit ALWAYS aktiviert werden.
 *
 * Legacy-Trigger ohne `activationMode` werden bewusst als MENTION_ONLY
 * interpretiert. Dadurch wird ein alter JSON-Bestand nach dem Deploy sicherer,
 * ohne dass eine destructive Datenmigration notwendig ist.
 */

export type TriggerActivationMode = 'MENTION_ONLY' | 'ALWAYS';

export interface MessageActivationInput {
  isMentioned: boolean;
  isReplyToBot: boolean;
  isAiCommand?: boolean;
  triggerActivationMode?: TriggerActivationMode | null;
}

export interface MessageActivationDecision {
  explicitBotAddress: boolean;
  allowAiResponse: boolean;
  allowTrigger: boolean;
  effectiveTriggerMode: TriggerActivationMode;
}

export function normalizeTriggerActivationMode(
  value: unknown,
): TriggerActivationMode {
  return value === 'ALWAYS' ? 'ALWAYS' : 'MENTION_ONLY';
}

export function decideMessageActivation(
  input: MessageActivationInput,
): MessageActivationDecision {
  const explicitBotAddress = Boolean(input.isMentioned || input.isReplyToBot || input.isAiCommand);
  const effectiveTriggerMode = normalizeTriggerActivationMode(input.triggerActivationMode);

  return {
    explicitBotAddress,
    allowAiResponse: explicitBotAddress,
    allowTrigger: explicitBotAddress || effectiveTriggerMode === 'ALWAYS',
    effectiveTriggerMode,
  };
}
