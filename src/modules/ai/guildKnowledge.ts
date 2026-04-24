import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { cosineSimilarity, embedKnowledgeSnippet, getQueryEmbedding } from './embeddings';

/**
 * Phase 8: Per-Guild Knowledge-Snippets.
 * Phase 9: Semantische Retrieval ueber Embeddings (Cosine), Fallback Keyword-Match.
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

// Mindest-Cosine-Score, ab dem ein Snippet als relevant gilt. Empirisch:
// Gemini text-embedding-004 liefert fuer wirklich verwandte Themen >0.55.
const SEMANTIC_MIN_SCORE = 0.55;

function keywordFallback(
  rows: Array<{ id: string; label: string; content: string }>,
  question: string,
  limit: number,
): KnowledgeSnippet[] {
  const qTokens = tokenize(question);
  if (qTokens.size === 0) return [];
  return rows
    .map((s) => {
      const lTokens = tokenize(s.label);
      let score = 0;
      for (const t of lTokens) if (qTokens.has(t)) score += 1;
      return { snip: s, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => ({ id: s.snip.id, label: s.snip.label, content: s.snip.content }));
}

/**
 * Liefert bis zu N relevante Snippets per semantischer Aehnlichkeit (Cosine).
 * Fallback: Keyword-Match auf Label-Tokens, falls keine Embeddings verfuegbar.
 */
export async function findRelevantKnowledge(
  guildId: string,
  question: string,
  limit = MAX_SNIPPETS_PER_PROMPT,
): Promise<KnowledgeSnippet[]> {
  try {
    const all = await prisma.guildKnowledge.findMany({
      where: { guildId, isActive: true },
      select: { id: true, label: true, content: true, embedding: true, embeddingModel: true },
      take: 200,
    });
    if (all.length === 0) return [];

    // Semantischer Pfad: Frage embedden, mit allen Snippet-Embeddings vergleichen.
    const qEmb = await getQueryEmbedding(question);
    if (qEmb) {
      const scored: Array<{ snip: KnowledgeSnippet; score: number }> = [];
      for (const row of all) {
        if (!row.embedding || !row.embeddingModel) continue;
        // Nur gleiche Modelle/Dimensionen vergleichen.
        if (row.embeddingModel !== qEmb.model) continue;
        let vec: number[] | null = null;
        try {
          vec = JSON.parse(row.embedding) as number[];
        } catch {
          vec = null;
        }
        if (!vec || vec.length !== qEmb.vector.length) continue;
        const score = cosineSimilarity(qEmb.vector, vec);
        if (score >= SEMANTIC_MIN_SCORE) {
          scored.push({ snip: { id: row.id, label: row.label, content: row.content }, score });
        }
      }
      if (scored.length > 0) {
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).map((s) => s.snip);
      }
    }

    // Fallback: Keyword-Match (Phase 8 Verhalten).
    return keywordFallback(
      all.map((r) => ({ id: r.id, label: r.label, content: r.content })),
      question,
      limit,
    );
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

  // Phase 9: Embedding asynchron generieren (kein await blockiert die Response).
  // Bei Fehlschlag (kein Provider) bleibt das Feld leer und Retrieval faellt auf Keyword zurueck.
  void embedKnowledgeSnippet(row.id).catch((e) => {
    logger.warn(`addKnowledge: Embedding fehlgeschlagen fuer ${row.id}: ${String(e)}`);
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
