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
  const cfg = await prisma.botConfig.findUnique({ where: { key: KEY(guildId) } });
  if (!cfg) return [];
  const arr = cfg.value as unknown;
  return Array.isArray(arr) ? (arr as AiTrigger[]) : [];
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
