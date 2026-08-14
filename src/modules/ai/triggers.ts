import prisma from '../../database/prisma';
import { isSafeRegexPattern, safeRegexTest } from '../../utils/safeRegex';
import {
  BOT_DEVELOPER,
  DEVELOPER_IDENTITY_TRIGGER_PATTERN,
  getDeveloperIdentityAnswer,
  isDeveloperIdentityQuestion,
} from './botIdentity';
import {
  decideMessageActivation,
  normalizeTriggerActivationMode,
  type TriggerActivationMode,
} from './messageActivation';

// Globale AI-Trigger – standardmaessig MENTION_ONLY. Ein passiver Trigger muss
// explizit activationMode='ALWAYS' setzen; Legacy-Eintraege ohne Feld werden
// sicher als MENTION_ONLY normalisiert.
export const GLOBAL_AI_TRIGGERS: AiTrigger[] = [
  {
    id: 'intro1',
    trigger: 'stell dich vor',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt: 'Stell dich locker und kurz vor (max. 2 Sätze, 1 Emoji). Kein „Hallo zusammen", kein Pathos – wie ein Kumpel der reinschneit.',
    cooldownSeconds: 10,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'intro2',
    trigger: 'stell dich vor',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt: 'Begrüße locker und kurz, sag was du machst (Slash-Commands, Hilfe, Trigger, AI). Max. 2 Sätze, 1 Emoji, Tick Humor.',
    cooldownSeconds: 10,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'intro3',
    trigger: 'stell dich vor',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt: 'Stell dich entspannt vor, lade Leute ein dich bei Fragen einfach zu taggen. Kein Standardtext, immer leicht anders.',
    cooldownSeconds: 10,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'intro4',
    trigger: 'stell dich vor',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt: 'Sag locker wer du bist und dass du immer ein offenes Ohr hast. Bisschen trocken, nicht steif.',
    cooldownSeconds: 10,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'order66',
    trigger: 'order 66',
    triggerType: 'keyword',
    responseMode: 'text',
    responseText: 'Lang lebe das Imperium. ||| Die Jedi werden fallen. ||| Befehl bestätigt. Eliminierung eingeleitet. ||| Für das Imperium gibt es kein Zurück. ||| Die Ordnung wird wiederhergestellt.',
    cooldownSeconds: 15,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'handwerk',
    trigger: 'was ist euer handwerk',
    triggerType: 'keyword',
    responseMode: 'text',
    responseText: 'ARHUUUU! ||| Spartaner! Was ist euer Handwerk?! ||| Kampf. Ehre. Ruhm. ||| Wir kämpfen im Schatten und siegen im Licht. ||| Heute kämpfen wir, morgen erinnern sie sich an uns.',
    cooldownSeconds: 15,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'erschaffer',
    trigger: DEVELOPER_IDENTITY_TRIGGER_PATTERN,
    triggerType: 'regex',
    responseMode: 'text',
    responseText: `Mein Entwickler ist **${BOT_DEVELOPER}**.`,
    cooldownSeconds: 30,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'commands',
    trigger: 'wie funktionieren deine commands',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt: 'Erkläre kurz und locker, wie deine Commands funktionieren: Slash-Commands (/), es gibt User-, Admin- und Developer-Commands, letztere nur für Berechtigte. Nenne 3-5 Beispiele wie /help, /level, /ai. Max. 800 Zeichen, kein Roman.',
    cooldownSeconds: 30,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'wascannstdu',
    trigger: 'was kannst du',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt: 'Sag locker und kurz, was du draufhast: Slash-Commands für User/Admin, AI-Antworten via Mention, Level/XP-System, Moderation, Polls, Giveaways, Uploads. Max. 4 Sätze, 1 Emoji.',
    cooldownSeconds: 30,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
  {
    id: 'wasbistdu',
    trigger: 'was bist du',
    triggerType: 'keyword',
    responseMode: 'ai',
    aiPrompt: 'Sag kurz und entspannt was du bist (Discord-Bot mit AI, Multi-Server, Slash-Commands). Max. 2 Sätze.',
    cooldownSeconds: 30,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },
];

export const MAX_TRIGGERS_PER_GUILD = 25;

export interface AiTrigger {
  id: string;
  trigger: string;
  triggerType: 'keyword' | 'regex' | 'mention';
  responseMode: 'text' | 'ai';
  responseText?: string;
  aiPrompt?: string;
  mediaUrl?: string;
  channelId?: string;
  /** Legacy/default = MENTION_ONLY; passiv nur mit explizitem ALWAYS. */
  activationMode?: TriggerActivationMode;
  cooldownSeconds: number;
  createdAt: string;
  createdBy: string;
}

const KEY = (guildId: string) => `triggers:${guildId}`;

function normalizeTrigger(trigger: AiTrigger): AiTrigger {
  return {
    ...trigger,
    activationMode: normalizeTriggerActivationMode(trigger.activationMode),
  };
}

function normalizeTriggers(value: unknown): AiTrigger[] {
  if (!Array.isArray(value)) return [];
  return (value as AiTrigger[]).map(normalizeTrigger);
}

/** Liefert nur die guild-eigenen Trigger (ohne globale). */
async function listGuildOnly(guildId: string): Promise<AiTrigger[]> {
  const cfg = await prisma.botConfig.findUnique({ where: { key: KEY(guildId) } });
  return cfg ? normalizeTriggers(cfg.value) : [];
}

export async function listTriggers(guildId: string): Promise<AiTrigger[]> {
  const global = GLOBAL_AI_TRIGGERS.map(normalizeTrigger);
  const cfg = await prisma.botConfig.findUnique({ where: { key: KEY(guildId) } });
  if (!cfg) return global;
  const guildTriggers = normalizeTriggers(cfg.value);
  const ids = new Set(guildTriggers.map(t => t.id));
  return [...global.filter(t => !ids.has(t.id)), ...guildTriggers];
}

export async function saveTriggers(guildId: string, triggers: AiTrigger[], updatedBy: string): Promise<void> {
  const normalized = triggers.map(normalizeTrigger);
  await prisma.botConfig.upsert({
    where: { key: KEY(guildId) },
    create: {
      key: KEY(guildId),
      value: normalized as unknown as object,
      category: 'ai_triggers',
      description: `AI-Trigger für Guild ${guildId}`,
      updatedBy,
    },
    update: { value: normalized as unknown as object, updatedBy },
  });
}

export async function addTrigger(guildId: string, trigger: AiTrigger): Promise<{ ok: boolean; message: string }> {
  const guildOnly = await listGuildOnly(guildId);
  if (guildOnly.length >= MAX_TRIGGERS_PER_GUILD) {
    return { ok: false, message: `Maximal ${MAX_TRIGGERS_PER_GUILD} eigene Trigger pro Server erlaubt (globale Trigger zaehlen nicht mit).` };
  }
  const combined = await listTriggers(guildId);
  if (combined.some(t => t.id === trigger.id)) {
    return { ok: false, message: `Trigger-ID "${trigger.id}" existiert bereits.` };
  }
  if (trigger.triggerType === 'regex' && !isSafeRegexPattern(trigger.trigger)) {
    return { ok: false, message: 'Ungültiges oder potenziell unsicheres Regex-Pattern (ReDoS-Schutz).' };
  }
  guildOnly.push(normalizeTrigger(trigger));
  await saveTriggers(guildId, guildOnly, trigger.createdBy);
  return { ok: true, message: `Trigger "${trigger.id}" gespeichert (${guildOnly.length}/${MAX_TRIGGERS_PER_GUILD}).` };
}

export async function removeTrigger(guildId: string, id: string, updatedBy: string): Promise<{ ok: boolean; message: string }> {
  const guildOnly = await listGuildOnly(guildId);
  const filtered = guildOnly.filter(t => t.id !== id);
  if (filtered.length === guildOnly.length) {
    if (GLOBAL_AI_TRIGGERS.some(t => t.id === id)) {
      return { ok: false, message: `Trigger "${id}" ist ein globaler Trigger und kann nicht entfernt werden.` };
    }
    return { ok: false, message: `Kein Trigger mit ID "${id}" gefunden.` };
  }
  await saveTriggers(guildId, filtered, updatedBy);
  return { ok: true, message: `Trigger "${id}" entfernt.` };
}

export async function clearTriggers(guildId: string, updatedBy: string): Promise<void> {
  await saveTriggers(guildId, [], updatedBy);
}

/**
 * Prueft eine Nachricht gegen alle Trigger der Guild.
 * `isExplicitBotAddress` bedeutet direkte Bot-Mention ODER Reply auf den Bot.
 * Legacy/Mention-only Trigger duerfen ohne diese explizite Ansprache nicht
 * feuern. Nur activationMode=ALWAYS erlaubt passive Trigger.
 */
export function findMatchingTrigger(
  triggers: AiTrigger[],
  content: string,
  isExplicitBotAddress: boolean,
): AiTrigger | null {
  if (isExplicitBotAddress && isDeveloperIdentityQuestion(content)) {
    return {
      id: 'system-developer-identity',
      trigger: DEVELOPER_IDENTITY_TRIGGER_PATTERN,
      triggerType: 'regex',
      responseMode: 'text',
      responseText: getDeveloperIdentityAnswer(),
      activationMode: 'MENTION_ONLY',
      cooldownSeconds: 0,
      createdAt: '2026-08-12T00:00:00.000Z',
      createdBy: 'system',
    };
  }

  const lower = content.toLowerCase();
  for (const rawTrigger of triggers) {
    const t = normalizeTrigger(rawTrigger);
    const activation = decideMessageActivation({
      isMentioned: isExplicitBotAddress,
      isReplyToBot: false,
      isAiCommand: false,
      triggerActivationMode: t.activationMode,
    });
    if (!activation.allowTrigger) continue;
    if (t.triggerType === 'mention' && !isExplicitBotAddress) continue;

    let match = false;
    if (t.triggerType === 'keyword' || t.triggerType === 'mention') {
      match = lower.includes(t.trigger.toLowerCase());
    } else if (t.triggerType === 'regex') {
      match = safeRegexTest(t.trigger, content, 'i');
    }

    if (match) {
      return isExplicitBotAddress ? { ...t, cooldownSeconds: 0 } : t;
    }
  }
  return null;
}

const cooldowns: Map<string, number> = new Map();

export function isOnCooldown(guildId: string, triggerId: string, cooldownSeconds: number): boolean {
  const key = `${guildId}:${triggerId}`;
  const last = cooldowns.get(key) || 0;
  if (Date.now() - last < cooldownSeconds * 1000) return true;
  cooldowns.set(key, Date.now());
  return false;
}

export function renderTemplate(text: string, vars: { user?: string; channel?: string }): string {
  const now = new Date();
  const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'long', timeZone: 'Europe/Berlin' }).format(now);
  const time = new Intl.DateTimeFormat('de-DE', { timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(now);
  return text
    .replace(/\{user\}/g, vars.user || '')
    .replace(/\{channel\}/g, vars.channel || '')
    .replace(/\{date\}/g, date)
    .replace(/\{time\}/g, time)
    .replace(/\{year\}/g, String(now.getFullYear()))
    .replace(/\{month\}/g, String(now.getMonth() + 1))
    .replace(/\{day\}/g, String(now.getDate()));
}
