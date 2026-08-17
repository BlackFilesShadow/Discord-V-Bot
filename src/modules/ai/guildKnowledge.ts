import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { cosineSimilarity, embedKnowledgeSnippet, getQueryEmbedding } from './embeddings';
import {
  filterKnowledgeRowsForScope,
  getKnowledgeAdminScopeMap,
  getKnowledgeScopeRows,
  globalKnowledgeScope,
  listKnowledgeGameservers,
  validateKnowledgeScope,
  type KnowledgeScopeMeta,
} from './knowledgeScope';

/**
 * Phase 8: Per-Guild Knowledge-Snippets.
 * Phase 9: Semantische Retrieval ueber Embeddings (Cosine), Fallback Keyword-Match.
 * AI-10: Guild-/Gameserver-Metadatenfilter VOR dem Hybrid-Reranking.
 *
 * Owner/Admin koennen kompakte Faktenbloecke hinterlegen, die der AI bei
 * passenden Anfragen mit in den Prompt fliessen. Token-Schutz: max 3 Snippets
 * pro Antwort. Fehlende Scope-Metadaten bedeuten rueckwaertskompatibel
 * guild-global; servergebundene Snippets werden nie zwischen Gameservern gemischt.
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

// Hybrid-Retrieval-Gewichte (Spec §6.C). Summe = 1.0.
//   semantic    : Cosine-Aehnlichkeit Frage<->Snippet-Embedding (0..1)
//   keyword     : normalisierter Token-Overlap-Score (0..1)
//   label       : Bonus, wenn ein Frage-Token exakt im Label vorkommt (0/1)
//   recency     : juengere Snippets leicht bevorzugt (0..1, exp. Abfall ueber 90d)
const HYBRID_WEIGHTS = { semantic: 0.65, keyword: 0.2, label: 0.1, recency: 0.05 } as const;
const HYBRID_MIN_SCORE = 0.12;
const RECENCY_HALF_LIFE_DAYS = 90;

interface ScoredRow {
  id: string;
  label: string;
  content: string;
  semantic: number;
  keyword: number;
  labelBoost: number;
  recency: number;
  hybrid: number;
  hadEmbedding: boolean;
}

function keywordScore(label: string, content: string, qTokens: Set<string>): { raw: number; labelBoost: number } {
  const lTokens = tokenize(label);
  const cTokens = tokenize(content);
  let raw = 0;
  let labelBoost = 0;
  for (const t of lTokens) if (qTokens.has(t)) { raw += 2; labelBoost = 1; }
  for (const t of cTokens) if (qTokens.has(t)) raw += 1;
  return { raw, labelBoost };
}

function recencyScore(createdAt: Date): number {
  const ageDays = (Date.now() - createdAt.getTime()) / 86_400_000;
  if (ageDays <= 0) return 1;
  return Math.pow(0.5, ageDays / RECENCY_HALF_LIFE_DAYS);
}

type KnowledgeRow = {
  id: string;
  label: string;
  content: string;
  embedding: string | null;
  embeddingModel: string | null;
  createdAt: Date;
};

/**
 * Kern-Scorer fuer Produktion und DEV-Retrieval-Debugger.
 * Caller MUESSEN Scope-Metadaten bereits vor diesem Schritt filtern.
 */
async function scoreKnowledge(
  rows: KnowledgeRow[],
  question: string,
): Promise<{ scored: ScoredRow[]; usedSemantic: boolean; queryModel: string | null }> {
  const qTokens = tokenize(question);
  let maxKeywordRaw = 0;
  const keywordCache = new Map<string, { raw: number; labelBoost: number }>();
  for (const r of rows) {
    const ks = keywordScore(r.label, r.content, qTokens);
    keywordCache.set(r.id, ks);
    if (ks.raw > maxKeywordRaw) maxKeywordRaw = ks.raw;
  }

  const qEmb = await getQueryEmbedding(question);
  const usedSemantic = !!qEmb;

  const scored: ScoredRow[] = rows.map((row) => {
    const ks = keywordCache.get(row.id)!;
    const keyword = maxKeywordRaw > 0 ? ks.raw / maxKeywordRaw : 0;

    let semantic = 0;
    let hadEmbedding = false;
    if (qEmb && row.embedding && row.embeddingModel === qEmb.model) {
      let vec: number[] | null = null;
      try { vec = JSON.parse(row.embedding) as number[]; } catch { vec = null; }
      if (vec && vec.length === qEmb.vector.length) {
        hadEmbedding = true;
        const cos = cosineSimilarity(qEmb.vector, vec);
        semantic = cos >= SEMANTIC_MIN_SCORE ? cos : 0;
      }
    }

    const recency = recencyScore(row.createdAt);
    const hybrid =
      HYBRID_WEIGHTS.semantic * semantic +
      HYBRID_WEIGHTS.keyword * keyword +
      HYBRID_WEIGHTS.label * ks.labelBoost +
      HYBRID_WEIGHTS.recency * recency;

    return {
      id: row.id,
      label: row.label,
      content: row.content,
      semantic,
      keyword,
      labelBoost: ks.labelBoost,
      recency,
      hybrid,
      hadEmbedding,
    };
  });

  scored.sort((a, b) => b.hybrid - a.hybrid);
  return { scored, usedSemantic, queryModel: qEmb?.model ?? null };
}

/**
 * Liefert relevante Snippets fuer exakt einen Retrieval-Scope.
 * `nitradoConnId=null` bedeutet bewusst GLOBAL-ONLY; bei gesetztem Scope
 * werden guild-globale + exakt diesem Gameserver zugeordnete Snippets gerankt.
 */
export async function findRelevantKnowledge(
  guildId: string,
  question: string,
  limit = MAX_SNIPPETS_PER_PROMPT,
  nitradoConnId: string | null = null,
): Promise<KnowledgeSnippet[]> {
  try {
    const [all, scopeRows] = await Promise.all([
      prisma.guildKnowledge.findMany({
        where: { guildId, isActive: true },
        select: { id: true, label: true, content: true, embedding: true, embeddingModel: true, createdAt: true },
        take: 200,
      }),
      getKnowledgeScopeRows(guildId),
    ]);
    const scoped = filterKnowledgeRowsForScope(all, scopeRows, nitradoConnId);
    if (scoped.length === 0) return [];

    const { scored } = await scoreKnowledge(scoped, question);
    return scored
      .filter((s) => s.hybrid >= HYBRID_MIN_SCORE)
      .slice(0, limit)
      .map((s) => ({ id: s.id, label: s.label, content: s.content }));
  } catch (e) {
    logger.warn('findRelevantKnowledge fehlgeschlagen:', { guildId, nitradoConnId, e: String(e) });
    return [];
  }
}

export interface RetrievalDebugSnippet {
  id: string;
  label: string;
  contentPreview: string;
  semantic: number;
  keyword: number;
  labelBoost: number;
  recency: number;
  hybrid: number;
  hadEmbedding: boolean;
  selected: boolean;
  reason: string;
}

export interface RetrievalDebugResult {
  question: string;
  totalSnippets: number;
  totalScopedCandidates: number;
  scopeNitradoConnId: string | null;
  usedSemantic: boolean;
  queryModel: string | null;
  weights: typeof HYBRID_WEIGHTS;
  minScore: number;
  limit: number;
  results: RetrievalDebugSnippet[];
}

/** Retrieval-Debugger mit identischem Scope-Filter + Scorer wie Produktion. */
export async function debugRetrieval(
  guildId: string,
  question: string,
  limit = MAX_SNIPPETS_PER_PROMPT,
  nitradoConnId: string | null = null,
): Promise<RetrievalDebugResult> {
  const [all, scopeRows] = await Promise.all([
    prisma.guildKnowledge.findMany({
      where: { guildId, isActive: true },
      select: { id: true, label: true, content: true, embedding: true, embeddingModel: true, createdAt: true },
      take: 200,
    }),
    getKnowledgeScopeRows(guildId),
  ]);
  const scoped = filterKnowledgeRowsForScope(all, scopeRows, nitradoConnId);
  const { scored, usedSemantic, queryModel } = await scoreKnowledge(scoped, question);
  const results: RetrievalDebugSnippet[] = scored.map((s, idx) => {
    const passesScore = s.hybrid >= HYBRID_MIN_SCORE;
    const selected = passesScore && idx < limit;
    let reason: string;
    if (!passesScore) reason = `Hybrid ${s.hybrid.toFixed(3)} < min ${HYBRID_MIN_SCORE}`;
    else if (idx >= limit) reason = `Rang ${idx + 1} ueber Limit ${limit}`;
    else if (s.semantic > 0 && s.labelBoost) reason = 'Semantik + Label-Treffer';
    else if (s.semantic > 0) reason = 'Semantische Aehnlichkeit';
    else if (s.labelBoost) reason = 'Label-Treffer (Keyword)';
    else reason = 'Keyword-Overlap';
    return {
      id: s.id,
      label: s.label,
      contentPreview: s.content.slice(0, 160),
      semantic: Number(s.semantic.toFixed(4)),
      keyword: Number(s.keyword.toFixed(4)),
      labelBoost: s.labelBoost,
      recency: Number(s.recency.toFixed(4)),
      hybrid: Number(s.hybrid.toFixed(4)),
      hadEmbedding: s.hadEmbedding,
      selected,
      reason,
    };
  });
  return {
    question,
    totalSnippets: all.length,
    totalScopedCandidates: scoped.length,
    scopeNitradoConnId: nitradoConnId,
    usedSemantic,
    queryModel,
    weights: HYBRID_WEIGHTS,
    minScore: HYBRID_MIN_SCORE,
    limit,
    results,
  };
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
  nitradoConnId: string | null = null,
): Promise<{ ok: boolean; message: string; id?: string }> {
  const cleanLabel = label.trim().slice(0, MAX_LABEL_LEN);
  const cleanContent = content.trim().slice(0, MAX_CONTENT_LEN);
  if (!cleanLabel || !cleanContent) return { ok: false, message: 'Label und Inhalt sind Pflicht.' };

  const scopeValidation = await validateKnowledgeScope(guildId, nitradoConnId);
  if (!scopeValidation.ok) return { ok: false, message: scopeValidation.message };

  const count = await prisma.guildKnowledge.count({ where: { guildId, isActive: true } });
  if (count >= MAX_SNIPPETS_PER_GUILD) {
    return { ok: false, message: `Limit erreicht (${MAX_SNIPPETS_PER_GUILD} Snippets pro Guild).` };
  }

  const exists = await prisma.guildProfile.findUnique({ where: { guildId }, select: { guildId: true } });
  if (!exists) {
    return { ok: false, message: 'Server-Profil noch nicht initialisiert. Bitte spaeter erneut versuchen.' };
  }

  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.guildKnowledge.create({
      data: { guildId, label: cleanLabel, content: cleanContent, createdBy },
    });
    if (scopeValidation.scope.type === 'GAMESERVER') {
      await tx.guildKnowledgeScope.create({
        data: { knowledgeId: created.id, guildId, nitradoConnId: scopeValidation.scope.nitradoConnId! },
      });
    }
    return created;
  });

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

// ── Admin/Dashboard-CRUD (volle Metadaten, inkl. inaktive Snippets) ─────────

export interface KnowledgeAdminRow {
  id: string;
  label: string;
  content: string;
  createdBy: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  hasEmbedding: boolean;
  embeddingModel: string | null;
  embeddedAt: Date | null;
  scope: KnowledgeScopeMeta;
}

/** Vollstaendige Liste fuer das Dashboard – inklusive deaktivierter Snippets. */
export async function listKnowledgeAdmin(guildId: string): Promise<KnowledgeAdminRow[]> {
  const [rows, scopeMap] = await Promise.all([
    prisma.guildKnowledge.findMany({
      where: { guildId },
      orderBy: [{ isActive: 'desc' }, { updatedAt: 'desc' }],
      select: {
        id: true, label: true, content: true, createdBy: true, isActive: true,
        createdAt: true, updatedAt: true, embedding: true, embeddingModel: true, embeddedAt: true,
      },
    }),
    getKnowledgeAdminScopeMap(guildId),
  ]);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    content: r.content,
    createdBy: r.createdBy,
    isActive: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    hasEmbedding: !!r.embedding,
    embeddingModel: r.embeddingModel,
    embeddedAt: r.embeddedAt,
    scope: scopeMap.get(r.id) ?? globalKnowledgeScope(),
  }));
}

/** Snippet bearbeiten; Scope-Aenderung und Inhalt werden atomar persistiert. */
export async function updateKnowledge(
  guildId: string,
  id: string,
  patch: { label?: string; content?: string; nitradoConnId?: string | null },
): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.guildKnowledge.findUnique({ where: { id } });
  if (!row || row.guildId !== guildId) return { ok: false, message: 'Snippet nicht gefunden.' };

  const data: { label?: string; content?: string } = {};
  if (patch.label !== undefined) {
    const cleanLabel = patch.label.trim().slice(0, MAX_LABEL_LEN);
    if (!cleanLabel) return { ok: false, message: 'Label darf nicht leer sein.' };
    data.label = cleanLabel;
  }
  if (patch.content !== undefined) {
    const cleanContent = patch.content.trim().slice(0, MAX_CONTENT_LEN);
    if (!cleanContent) return { ok: false, message: 'Inhalt darf nicht leer sein.' };
    data.content = cleanContent;
  }

  const scopeChange = Object.prototype.hasOwnProperty.call(patch, 'nitradoConnId');
  let scopeValidation: Awaited<ReturnType<typeof validateKnowledgeScope>> | null = null;
  if (scopeChange) {
    scopeValidation = await validateKnowledgeScope(guildId, patch.nitradoConnId ?? null);
    if (!scopeValidation.ok) return { ok: false, message: scopeValidation.message };
  }
  if (Object.keys(data).length === 0 && !scopeChange) return { ok: false, message: 'Keine Aenderungen uebergeben.' };

  await prisma.$transaction(async (tx) => {
    if (Object.keys(data).length > 0) await tx.guildKnowledge.update({ where: { id }, data });
    if (scopeChange && scopeValidation?.ok) {
      if (scopeValidation.scope.type === 'GLOBAL') {
        await tx.guildKnowledgeScope.deleteMany({ where: { knowledgeId: id, guildId } });
      } else {
        await tx.guildKnowledgeScope.upsert({
          where: { knowledgeId: id },
          create: { knowledgeId: id, guildId, nitradoConnId: scopeValidation.scope.nitradoConnId! },
          update: { guildId, nitradoConnId: scopeValidation.scope.nitradoConnId! },
        });
      }
    }
  });

  if (data.label !== undefined || data.content !== undefined) {
    void embedKnowledgeSnippet(id).catch((e) => {
      logger.warn(`updateKnowledge: Re-Embedding fehlgeschlagen fuer ${id}: ${String(e)}`);
    });
  }
  return { ok: true, message: `Snippet ${id.slice(0, 8)} aktualisiert.` };
}

/** Snippet aktivieren/deaktivieren; veralteter Gameserver-Scope bleibt fail-closed. */
export async function setKnowledgeActive(
  guildId: string,
  id: string,
  active: boolean,
): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.guildKnowledge.findUnique({ where: { id } });
  if (!row || row.guildId !== guildId) return { ok: false, message: 'Snippet nicht gefunden.' };
  if (active) {
    const scopeRow = await prisma.guildKnowledgeScope.findFirst({
      where: { knowledgeId: id, guildId },
      select: { nitradoConnId: true },
    });
    if (scopeRow) {
      const scopeValidation = await validateKnowledgeScope(guildId, scopeRow.nitradoConnId);
      if (!scopeValidation.ok) return { ok: false, message: `Snippet-Scope ungueltig: ${scopeValidation.message}` };
    }
    const count = await prisma.guildKnowledge.count({ where: { guildId, isActive: true } });
    if (!row.isActive && count >= MAX_SNIPPETS_PER_GUILD) {
      return { ok: false, message: `Limit erreicht (${MAX_SNIPPETS_PER_GUILD} aktive Snippets pro Guild).` };
    }
  }
  await prisma.guildKnowledge.update({ where: { id }, data: { isActive: active } });
  return { ok: true, message: active ? 'Snippet aktiviert.' : 'Snippet deaktiviert.' };
}

/** Embedding eines Snippets manuell neu berechnen (synchron, Status zurueckmelden). */
export async function reembedKnowledge(guildId: string, id: string): Promise<{ ok: boolean; message: string }> {
  const row = await prisma.guildKnowledge.findUnique({ where: { id }, select: { guildId: true } });
  if (!row || row.guildId !== guildId) return { ok: false, message: 'Snippet nicht gefunden.' };
  const ok = await embedKnowledgeSnippet(id);
  return ok
    ? { ok: true, message: 'Embedding neu berechnet.' }
    : { ok: false, message: 'Kein Embedding-Provider verfuegbar – Snippet nutzt Keyword-Retrieval.' };
}

export interface KnowledgeExportItem {
  label: string;
  content: string;
  scopeType: 'GLOBAL' | 'GAMESERVER';
  scopeSlot: number | null;
}

/** Alle aktiven Snippets als portables JSON; Gameserver werden ueber Slot exportiert. */
export async function exportKnowledge(guildId: string): Promise<KnowledgeExportItem[]> {
  const [rows, scopeMap] = await Promise.all([
    prisma.guildKnowledge.findMany({
      where: { guildId, isActive: true },
      orderBy: { createdAt: 'asc' },
      select: { id: true, label: true, content: true },
    }),
    getKnowledgeAdminScopeMap(guildId),
  ]);
  return rows.map((r) => {
    const scope = scopeMap.get(r.id) ?? globalKnowledgeScope();
    return {
      label: r.label,
      content: r.content,
      scopeType: scope.type,
      scopeSlot: scope.type === 'GAMESERVER' ? scope.slot : null,
    };
  });
}

/** Mehrere Snippets gebuendelt importieren; ungueltige Server-Slots werden nie globalisiert. */
export async function importKnowledge(
  guildId: string,
  items: Array<{ label?: unknown; content?: unknown; scopeType?: unknown; scopeSlot?: unknown }>,
  createdBy: string,
): Promise<{ ok: boolean; message: string; added: number; skipped: number }> {
  const exists = await prisma.guildProfile.findUnique({ where: { guildId }, select: { guildId: true } });
  if (!exists) return { ok: false, message: 'Server-Profil noch nicht initialisiert.', added: 0, skipped: 0 };

  const servers = await listKnowledgeGameservers(guildId);
  let active = await prisma.guildKnowledge.count({ where: { guildId, isActive: true } });
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    if (active >= MAX_SNIPPETS_PER_GUILD) { skipped++; continue; }
    const label = typeof item.label === 'string' ? item.label.trim().slice(0, MAX_LABEL_LEN) : '';
    const content = typeof item.content === 'string' ? item.content.trim().slice(0, MAX_CONTENT_LEN) : '';
    if (!label || !content) { skipped++; continue; }

    const wantsGameserver = item.scopeType === 'GAMESERVER' || (item.scopeSlot !== undefined && item.scopeSlot !== null);
    let nitradoConnId: string | null = null;
    if (wantsGameserver) {
      const parsedSlot = typeof item.scopeSlot === 'number' ? item.scopeSlot : Number(item.scopeSlot);
      if (!Number.isInteger(parsedSlot)) { skipped++; continue; }
      const selected = servers.find((s) => s.slot === parsedSlot);
      if (!selected) { skipped++; continue; }
      nitradoConnId = selected.id;
    }

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.guildKnowledge.create({ data: { guildId, label, content, createdBy } });
      if (nitradoConnId) {
        await tx.guildKnowledgeScope.create({ data: { knowledgeId: created.id, guildId, nitradoConnId } });
      }
      return created;
    });
    active++;
    added++;
    void embedKnowledgeSnippet(row.id).catch((e) => {
      logger.warn(`importKnowledge: Embedding fehlgeschlagen fuer ${row.id}: ${String(e)}`);
    });
  }
  return { ok: added > 0, message: `${added} importiert, ${skipped} uebersprungen.`, added, skipped };
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
 * Erstellt einen kompakten Brief des Discord-Servers aus guild-globalen Daten.
 * Gameserver-spezifische Knowledge-Labels werden AI-10-konform NICHT in den
 * globalen Brief eingemischt.
 */
export async function regenerateAiBrief(guildId: string): Promise<string | null> {
  const p = await prisma.guildProfile.findUnique({ where: { guildId } });
  if (!p) return null;

  const facts: string[] = [];
  facts.push(`Servername: "${p.name}"`);
  facts.push(`Mitglieder: ${p.memberCount}`);
  if (p.description) facts.push(`Beschreibung: ${p.description.slice(0, 400)}`);
  if (p.preferredLocale) facts.push(`Sprache: ${p.preferredLocale}`);
  const ch = Array.isArray(p.channelsJson) ? (p.channelsJson as Array<{ name: string; type: string }>) : [];
  if (ch.length > 0) {
    const cats = ch.filter((c) => c.type === 'category').map((c) => c.name).slice(0, 8);
    const text = ch.filter((c) => c.type === 'text').map((c) => `#${c.name}`).slice(0, 12);
    if (cats.length > 0) facts.push(`Kategorien: ${cats.join(', ')}`);
    if (text.length > 0) facts.push(`Wichtige Text-Channels: ${text.join(', ')}`);
  }
  if (p.rulesText) facts.push(`Regelwerk-Auszug: ${p.rulesText.slice(0, 600)}`);

  const [knowledgeCandidates, scopeRows] = await Promise.all([
    prisma.guildKnowledge.findMany({
      where: { guildId, isActive: true },
      select: { id: true, label: true },
      orderBy: { createdAt: 'desc' },
      take: MAX_SNIPPETS_PER_GUILD,
    }),
    getKnowledgeScopeRows(guildId),
  ]);
  const knowledgeRows = filterKnowledgeRowsForScope(knowledgeCandidates, scopeRows, null).slice(0, 20);
  if (knowledgeRows.length > 0) {
    facts.push(`Hinterlegte globale Knowledge-Snippets (${knowledgeRows.length}): ${knowledgeRows.map((r) => r.label).join(', ')}`);
  }

  const deterministic = (() => {
    const lines: string[] = [];
    lines.push(`"${p.name}" ist ein Discord-Server mit ${p.memberCount} Mitgliedern.`);
    if (p.description) lines.push(`Beschreibung: ${p.description.slice(0, 240)}.`);
    if (p.preferredLocale) lines.push(`Sprache: ${p.preferredLocale}.`);
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
    if (knowledgeRows.length > 0) lines.push(`Es sind ${knowledgeRows.length} globale kuratierte Knowledge-Snippets hinterlegt.`);
    return lines.join(' ').slice(0, 1500);
  })();

  let brief = deterministic;
  try {
    const { callAI } = await import('./aiHandler.js');
    const sysPrompt = [
      'Du verdichtest Discord-Server-Stammdaten zu einem praezisen, dichten Brief.',
      'Maximal 6 Saetze, deutsch, sachlich und neutral. Keine Anrede, keine Floskeln, keine Wiederholungen.',
      'Beschreibe Charakter und Themenfelder des Servers, nenne wichtigste Channels/Kategorien knapp.',
      'Erfinde NICHTS. Nutze nur die gelieferten Fakten.',
      'Keine Markdown-Formatierung, keine Aufzaehlungen, kein Code-Block.',
    ].join('\n');
    const userPrompt = ['Server-Fakten:', ...facts.map((f) => `- ${f}`)].join('\n');
    const llm = await callAI([
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ]);
    const cleaned = llm.trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 1500);
    if (cleaned.length >= 40) {
      brief = cleaned;
    } else {
      logger.warn(`regenerateAiBrief: LLM-Antwort zu kurz (${cleaned.length}ch), nutze deterministischen Fallback.`);
    }
  } catch (e) {
    logger.warn(`regenerateAiBrief: LLM-Call fehlgeschlagen (${String(e)}), nutze deterministischen Fallback.`);
  }

  await prisma.guildProfile.update({
    where: { guildId },
    data: { aiBrief: brief, aiBriefAt: new Date() },
  });
  return brief;
}
