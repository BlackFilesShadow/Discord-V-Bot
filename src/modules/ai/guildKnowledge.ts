import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';

/**
 * Phase 8: Per-Guild Knowledge-Snippets.
 *
 * Owner/Admin koennen kompakte Faktenbloecke hinterlegen, die der AI bei
 * passenden Anfragen mit in den Prompt fliessen. Match laeuft ueber das
 * Label (Schluesselwort) – ist es im Frage-Text enthalten, wird der Snippet
 * eingespeist. Token-Schutz: max 3 Snippets pro Antwort.
 */

const MAX_SNIPPETS_PER_PROMPT = 3;
const MAX_LABEL_LEN = 60;
const MAX_CONTENT_LEN = 2000;
const MAX_SNIPPETS_PER_GUILD = 50;

export interface KnowledgeSnippet {
  id: string;
  label: string;
  content: string;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\u00e4\u00f6\u00fc\u00df\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
}

/**
 * Liefert bis zu N Snippets, deren Label-Tokens in der Frage vorkommen.
 * Sortiert nach Anzahl der Treffer.
 */
export async function findRelevantKnowledge(
  guildId: string,
  question: string,
  limit = MAX_SNIPPETS_PER_PROMPT,
): Promise<KnowledgeSnippet[]> {
  try {
    const all = await prisma.guildKnowledge.findMany({
      where: { guildId, isActive: true },
      select: { id: true, label: true, content: true },
      take: 100,
    });
    if (all.length === 0) return [];
    const qTokens = tokenize(question);
    if (qTokens.size === 0) return [];
    const scored = all
      .map((s) => {
        const lTokens = tokenize(s.label);
        let score = 0;
        for (const t of lTokens) if (qTokens.has(t)) score += 1;
        return { snip: s, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return scored.map((s) => s.snip);
  } catch (e) {
    logger.warn('findRelevantKnowledge fehlgeschlagen:', { guildId, e: String(e) });
    return [];
  }
}

export async function listKnowledge(guildId: string): Promise<KnowledgeSnippet[]> {
  return prisma.guildKnowledge.findMany({
    where: { guildId, isActive: true },
    select: { id: true, label: true, content: true },
    orderBy: { createdAt: 'desc' },
  });
}

export async function addKnowledge(
  guildId: string,
  label: string,
  content: string,
  createdBy: string,
): Promise<{ ok: boolean; message: string; id?: string }> {
  const cleanLabel = label.trim().slice(0, MAX_LABEL_LEN);
  const cleanContent = content.trim().slice(0, MAX_CONTENT_LEN);
  if (!cleanLabel || !cleanContent) return { ok: false, message: 'Label und Inhalt sind Pflicht.' };

  const count = await prisma.guildKnowledge.count({ where: { guildId, isActive: true } });
  if (count >= MAX_SNIPPETS_PER_GUILD) {
    return { ok: false, message: `Limit erreicht (${MAX_SNIPPETS_PER_GUILD} Snippets pro Server).` };
  }

  // GuildProfile sicherstellen – sonst FK-Fehler.
  const exists = await prisma.guildProfile.findUnique({ where: { guildId }, select: { guildId: true } });
  if (!exists) {
    return { ok: false, message: 'Server-Profil noch nicht initialisiert. Bitte spaeter erneut versuchen.' };
  }

  const row = await prisma.guildKnowledge.create({
    data: { guildId, label: cleanLabel, content: cleanContent, createdBy },
  });
  return { ok: true, message: `Snippet hinzugefuegt (#${row.id.slice(0, 8)}).`, id: row.id };
}

export async function removeKnowledge(guildId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.guildKnowledge.findUnique({ where: { id } });
  if (!row || row.guildId !== guildId) return { ok: false, message: 'Snippet nicht gefunden.' };
  await prisma.guildKnowledge.update({ where: { id }, data: { isActive: false } });
  return { ok: true, message: `Snippet ${id.slice(0, 8)} deaktiviert.` };
}

export async function setPersonaOverride(
  guildId: string,
  text: string | null,
): Promise<{ ok: boolean; message: string }> {
  const exists = await prisma.guildProfile.findUnique({ where: { guildId }, select: { guildId: true } });
  if (!exists) return { ok: false, message: 'Server-Profil noch nicht initialisiert.' };
  await prisma.guildProfile.update({
    where: { guildId },
    data: { aiPersonaOverride: text ? text.slice(0, 1500) : null },
  });
  return { ok: true, message: text ? 'Persona-Override gesetzt.' : 'Persona-Override entfernt.' };
}

/**
 * Erstellt einen kompakten Brief des Servers aus Stammdaten + Rules + Top-Channels.
 * Wird in syncGuildContent aufgerufen, kein eigenes LLM noetig (deterministisch).
 */
export async function regenerateAiBrief(guildId: string): Promise<string | null> {
  const p = await prisma.guildProfile.findUnique({ where: { guildId } });
  if (!p) return null;
  const lines: string[] = [];
  lines.push(`"${p.name}" ist ein Discord-Server mit ${p.memberCount} Mitgliedern.`);
  if (p.description) lines.push(`Beschreibung: ${p.description.slice(0, 240)}.`);
  if (p.preferredLocale) lines.push(`Sprache: ${p.preferredLocale}.`);
  const ch = Array.isArray(p.channelsJson) ? (p.channelsJson as Array<{ name: string; type: string }>) : [];
  if (ch.length > 0) {
    const cats = ch.filter((c) => c.type === 'category').map((c) => c.name).slice(0, 6);
    const text = ch.filter((c) => c.type === 'text').map((c) => `#${c.name}`).slice(0, 8);
    if (cats.length > 0) lines.push(`Kategorien: ${cats.join(', ')}.`);
    if (text.length > 0) lines.push(`Wichtige Text-Channels: ${text.join(', ')}.`);
  }
  if (p.rulesText) {
    const firstSentence = p.rulesText.split(/[.!?]\s/).slice(0, 2).join('. ');
    if (firstSentence) lines.push(`Regelwerk-Kern: ${firstSentence.slice(0, 280)}.`);
  }
  const knowledgeCount = await prisma.guildKnowledge.count({ where: { guildId, isActive: true } });
  if (knowledgeCount > 0) lines.push(`Es sind ${knowledgeCount} kuratierte Knowledge-Snippets hinterlegt.`);
  const brief = lines.join(' ').slice(0, 1500);
  await prisma.guildProfile.update({
    where: { guildId },
    data: { aiBrief: brief, aiBriefAt: new Date() },
  });
  return brief;
}
