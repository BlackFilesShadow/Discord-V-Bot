import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import prisma from '../../database/prisma';

/**
 * Phase 9 (B2 RAG): Embedding-Service mit Multi-Provider-Fallback (Gemini -> OpenAI).
 *
 * - Gemini: text-embedding-004 (768 dim, gratis mit GEMINI_API_KEY)
 * - OpenAI: text-embedding-3-small (1536 dim, kostenpflichtig)
 *
 * Vektoren werden als JSON-Array von Floats serialisiert in GuildKnowledge.embedding
 * gespeichert. Cosine-Similarity wird in JS berechnet (Skala dieses Bots ist klein
 * genug, dass kein pgvector-Index noetig ist).
 */

export interface Embedding {
  vector: number[];
  model: string;
}

const GEMINI_MODEL = 'text-embedding-004';
const OPENAI_MODEL = 'text-embedding-3-small';

// In-Memory Cache fuer Anfrage-Embeddings (Hash -> Vektor). Vermeidet doppelte
// API-Calls, wenn dieselbe Frage mehrfach in kurzer Zeit gestellt wird.
const queryCache = new Map<string, Embedding>();
const QUERY_CACHE_MAX = 200;

function cacheKey(text: string): string {
  // Einfache, kollisionsarme Repraesentation; fuer einen Cache reicht das.
  return text.trim().toLowerCase().slice(0, 500);
}

/**
 * Cosine-Similarity zweier Vektoren. Erwartet gleiche Dimension; bei
 * Mismatch wird 0 zurueckgegeben (Gemini=768, OpenAI=1536 mischen nicht).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

async function embedGemini(text: string): Promise<Embedding | null> {
  if (!config.ai.geminiApiKey) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:embedContent?key=${config.ai.geminiApiKey}`;
  const res = await axios.post(
    url,
    { content: { parts: [{ text }] } },
    { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
  );
  const values = res.data?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  return { vector: values as number[], model: `gemini:${GEMINI_MODEL}` };
}

async function embedOpenAI(text: string): Promise<Embedding | null> {
  if (!config.ai.openaiApiKey) return null;
  const res = await axios.post(
    'https://api.openai.com/v1/embeddings',
    { model: OPENAI_MODEL, input: text },
    {
      headers: {
        Authorization: `Bearer ${config.ai.openaiApiKey}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    },
  );
  const values = res.data?.data?.[0]?.embedding;
  if (!Array.isArray(values) || values.length === 0) return null;
  return { vector: values as number[], model: `openai:${OPENAI_MODEL}` };
}

/**
 * Erzeugt ein Embedding mit Fallback Gemini -> OpenAI. Liefert null wenn
 * kein Provider verfuegbar/erfolgreich ist (RAG fae$llt dann auf Keyword-Match zurueck).
 */
export async function generateEmbedding(text: string): Promise<Embedding | null> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const providers: Array<{ name: string; fn: () => Promise<Embedding | null> }> = [
    { name: 'gemini', fn: () => embedGemini(trimmed) },
    { name: 'openai', fn: () => embedOpenAI(trimmed) },
  ];

  for (const p of providers) {
    try {
      const emb = await p.fn();
      if (emb) return emb;
    } catch (e) {
      logger.warn(`embedding: Provider ${p.name} fehlgeschlagen: ${String(e)}`);
    }
  }
  return null;
}

/**
 * Holt ein Embedding fuer einen Suchbegriff aus dem Cache oder generiert es neu.
 */
export async function getQueryEmbedding(text: string): Promise<Embedding | null> {
  const key = cacheKey(text);
  const hit = queryCache.get(key);
  if (hit) return hit;
  const emb = await generateEmbedding(text);
  if (emb) {
    if (queryCache.size >= QUERY_CACHE_MAX) {
      const firstKey = queryCache.keys().next().value;
      if (firstKey !== undefined) queryCache.delete(firstKey);
    }
    queryCache.set(key, emb);
  }
  return emb;
}

/**
 * Embedding eines GuildKnowledge-Snippets erzeugen und in der DB speichern.
 * Idempotent: liefert false wenn kein Provider verfuegbar war.
 */
export async function embedKnowledgeSnippet(id: string): Promise<boolean> {
  const row = await (prisma as unknown as {
    guildKnowledge: { findUnique: (args: unknown) => Promise<{ id: string; label: string; content: string } | null> };
  }).guildKnowledge.findUnique({ where: { id } });
  if (!row) return false;
  const text = `${row.label}\n${row.content}`;
  const emb = await generateEmbedding(text);
  if (!emb) return false;
  await (prisma as unknown as {
    guildKnowledge: { update: (args: unknown) => Promise<unknown> };
  }).guildKnowledge.update({
    where: { id },
    data: {
      embedding: JSON.stringify(emb.vector),
      embeddingModel: emb.model,
      embeddedAt: new Date(),
    },
  });
  return true;
}

/**
 * Embed alle aktiven Snippets einer Guild (oder global), bei denen noch kein
 * Embedding hinterlegt ist. Wird beim Bot-Startup einmalig getriggert.
 */
export async function backfillEmbeddings(guildId?: string): Promise<{ done: number; skipped: number }> {
  const where: Record<string, unknown> = { isActive: true, embedding: null };
  if (guildId) where.guildId = guildId;
  const rows = await (prisma as unknown as {
    guildKnowledge: { findMany: (args: unknown) => Promise<Array<{ id: string; label: string; content: string }>> };
  }).guildKnowledge.findMany({ where, select: { id: true, label: true, content: true } });
  let done = 0;
  let skipped = 0;
  for (const r of rows) {
    const ok = await embedKnowledgeSnippet(r.id);
    if (ok) done++;
    else skipped++;
    // sanftes Throttling damit wir keine Rate-Limits provozieren
    if (rows.length > 5) await new Promise((res) => setTimeout(res, 200));
  }
  if (rows.length > 0) {
    logger.info(`Embedding-Backfill: ${done}/${rows.length} embedded, ${skipped} ohne Provider.`);
  }
  return { done, skipped };
}

/**
 * Prueft beim Startup einmalig, ob die pgvector-Extension in der DB verfuegbar ist.
 * Wird aktuell rein informativ geloggt; die JS-Cosine-Suche reicht fuer die Skala.
 */
let pgvectorChecked = false;
let pgvectorAvailable = false;
export async function checkPgvectorAvailability(): Promise<boolean> {
  if (pgvectorChecked) return pgvectorAvailable;
  pgvectorChecked = true;
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ exists: boolean }>>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') AS exists`,
    );
    pgvectorAvailable = Boolean(rows?.[0]?.exists);
  } catch {
    pgvectorAvailable = false;
  }
  logger.info(`RAG: pgvector ${pgvectorAvailable ? 'verfuegbar' : 'NICHT verfuegbar - JS-Fallback aktiv'}.`);
  return pgvectorAvailable;
}
