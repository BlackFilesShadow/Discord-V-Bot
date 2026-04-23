// Globale AI-Trigger – feuern auf JEDEM Server, auf dem der Bot ist.
// Können nicht über /ai-trigger gelöscht werden, da sie hardcoded sind.
export const GLOBAL_AI_TRIGGERS: AiTrigger[] = [
  // ===== INTRO =====
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

  // ===== STAR WARS / ORDER 66 =====
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

  // ===== SPARTAN / 300 =====
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

  // ===== HERKUNFT / ERSCHAFFER =====
  {
    id: 'erschaffer',
    trigger: 'wer hat dich (gebaut|erschaffen|erstellt|programmiert|gemacht|entwickelt|gecodet)',
    triggerType: 'regex',
    responseMode: 'text',
    responseText: 'Ich wurde von **Void_Architect** erschaffen.\nMeine Aufgabe: unterstützen, helfen, Infos liefern – effizient, klar, zuverlässig. Mit einem Schuss Persönlichkeit obendrauf.',
    cooldownSeconds: 30,
    createdAt: '2026-04-23T00:00:00.000Z',
    createdBy: 'system',
  },

  // ===== COMMANDS / WAS KANNST DU =====
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
import prisma from '../../database/prisma';

/**
 * AI-Trigger pro Guild (max 10).
 * Persistiert in BotConfig (key=`triggers:<guildId>`, value=Json[]).
 *
 * Trigger-Typen:
 *  - keyword: Substring-Match (case-insensitive)
 *  - regex:   RegExp-Match
 *  - mention: nur wenn Bot direkt erw\u00e4hnt + Wort enthalten
 *
 * Antwort-Modi:
 *  - text: statischer Text (kann Variablen wie {user}, {time}, {date}, {year} enthalten)
 *  - ai:   AI generiert Antwort mit aiPrompt als zus\u00e4tzlichem System-Hinweis
 */

export const MAX_TRIGGERS_PER_GUILD = 10;

export interface AiTrigger {
  id: string;             // kurze ID (z.B. nanoid 6)
  trigger: string;        // Pattern
  triggerType: 'keyword' | 'regex' | 'mention';
  responseMode: 'text' | 'ai';
  responseText?: string;  // bei mode=text
  aiPrompt?: string;      // bei mode=ai (zus\u00e4tzlicher System-Prompt)
  mediaUrl?: string;      // optional JPG/PNG/GIF/MP4-URL, wird als Anhang/Embed gesendet
  channelId?: string;     // optional: Trigger feuert NUR in diesem Channel (leer = \u00fcberall)
  cooldownSeconds: number;
  createdAt: string;      // ISO
  createdBy: string;      // Discord-ID
}

const KEY = (guildId: string) => `triggers:${guildId}`;

export async function listTriggers(guildId: string): Promise<AiTrigger[]> {
  // Globale Trigger immer zuerst
  const global = GLOBAL_AI_TRIGGERS;
  const cfg = await prisma.botConfig.findUnique({ where: { key: KEY(guildId) } });
  if (!cfg) return global;
  const arr = cfg.value as unknown;
  const guildTriggers = Array.isArray(arr) ? (arr as AiTrigger[]) : [];
  // Kombiniere globale und guild-spezifische Trigger (guild überschreibt id-Kollisionen)
  const ids = new Set(guildTriggers.map(t => t.id));
  return [...global.filter(t => !ids.has(t.id)), ...guildTriggers];
}

export async function saveTriggers(guildId: string, triggers: AiTrigger[], updatedBy: string): Promise<void> {
  await prisma.botConfig.upsert({
    where: { key: KEY(guildId) },
    create: {
      key: KEY(guildId),
      value: triggers as unknown as object,
      category: 'ai_triggers',
      description: `AI-Trigger f\u00fcr Guild ${guildId}`,
      updatedBy,
    },
    update: { value: triggers as unknown as object, updatedBy },
  });
}

export async function addTrigger(guildId: string, trigger: AiTrigger): Promise<{ ok: boolean; message: string }> {
  const list = await listTriggers(guildId);
  if (list.length >= MAX_TRIGGERS_PER_GUILD) {
    return { ok: false, message: `Maximal ${MAX_TRIGGERS_PER_GUILD} Trigger pro Server erlaubt.` };
  }
  if (list.some(t => t.id === trigger.id)) {
    return { ok: false, message: `Trigger-ID "${trigger.id}" existiert bereits.` };
  }
  // Regex validieren
  if (trigger.triggerType === 'regex') {
    try { new RegExp(trigger.trigger); }
    catch { return { ok: false, message: 'Ung\u00fcltiges Regex-Pattern.' }; }
  }
  list.push(trigger);
  await saveTriggers(guildId, list, trigger.createdBy);
  return { ok: true, message: `Trigger "${trigger.id}" gespeichert (${list.length}/${MAX_TRIGGERS_PER_GUILD}).` };
}

export async function removeTrigger(guildId: string, id: string, updatedBy: string): Promise<{ ok: boolean; message: string }> {
  const list = await listTriggers(guildId);
  const filtered = list.filter(t => t.id !== id);
  if (filtered.length === list.length) {
    return { ok: false, message: `Kein Trigger mit ID "${id}" gefunden.` };
  }
  await saveTriggers(guildId, filtered, updatedBy);
  return { ok: true, message: `Trigger "${id}" entfernt.` };
}

export async function clearTriggers(guildId: string, updatedBy: string): Promise<void> {
  await saveTriggers(guildId, [], updatedBy);
}

/**
 * Pr\u00fcft eine Nachricht gegen alle Trigger der Guild.
 * Gibt den ersten passenden Trigger zur\u00fcck oder null.
 */
export function findMatchingTrigger(
  triggers: AiTrigger[],
  content: string,
  isMention: boolean,
): AiTrigger | null {
  const lower = content.toLowerCase();
  for (const t of triggers) {
    if (t.triggerType === 'mention' && !isMention) continue;
    let match = false;
    if (t.triggerType === 'keyword' || t.triggerType === 'mention') {
      match = lower.includes(t.trigger.toLowerCase());
    } else if (t.triggerType === 'regex') {
      try { match = new RegExp(t.trigger, 'i').test(content); }
      catch { match = false; }
    }
    if (match) return t;
  }
  return null;
}

// Cooldowns pro Guild+Trigger
const cooldowns: Map<string, number> = new Map();

export function isOnCooldown(guildId: string, triggerId: string, cooldownSeconds: number): boolean {
  const key = `${guildId}:${triggerId}`;
  const last = cooldowns.get(key) || 0;
  if (Date.now() - last < cooldownSeconds * 1000) return true;
  cooldowns.set(key, Date.now());
  return false;
}

/**
 * Ersetzt Variablen in statischen Antworten.
 */
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
