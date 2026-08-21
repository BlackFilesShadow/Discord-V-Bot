/* eslint-disable local/no-unscoped-prisma-query -- Stage 64: guild boundary enforced at auth/API or entity-id unique after prior guild check; Prisma update/delete require unique where. */
import prisma from '../../database/prisma';
import { MAX_GAME_SERVERS_PER_GUILD, slotState } from '../nitrado/gameServerScope';
import { looksLikeLiveServerKnowledgeQuestion } from './dayzKnowledgeBoundary';

export { looksLikeLiveServerKnowledgeQuestion } from './dayzKnowledgeBoundary';

export interface KnowledgeGameserverOption {
  id: string;
  slot: number;
  alias: string;
  alias5: string;
}

export interface KnowledgeScopeMeta {
  type: 'GLOBAL' | 'GAMESERVER';
  nitradoConnId: string | null;
  slot: number | null;
  alias: string | null;
  alias5: string | null;
}

export type KnowledgeScopeValidation =
  | { ok: true; scope: KnowledgeScopeMeta }
  | { ok: false; message: string };

/**
 * Nur produktiv nutzbare Gameserver fuer Knowledge-Scope anbieten.
 * Legacy-Slot 5, inaktive und noch nicht an eine Nitrado-Service-ID gebundene
 * Connections werden absichtlich nicht als RAG-Scope freigegeben.
 */
export async function listKnowledgeGameservers(guildId: string): Promise<KnowledgeGameserverOption[]> {
  const rows = await prisma.nitradoConnection.findMany({
    where: {
      guildId,
      status: 'ACTIVE',
      slot: { gte: 1, lte: MAX_GAME_SERVERS_PER_GUILD },
      nitradoServerId: { not: null },
    },
    select: { id: true, slot: true, alias: true, alias5: true, nitradoServerId: true },
    orderBy: [{ slot: 'asc' }, { id: 'asc' }],
  });
  return rows
    .filter((r) => (
      slotState(r.slot) === 'ACTIVE_SLOT'
      && typeof r.nitradoServerId === 'string'
      && r.nitradoServerId.trim().length > 0
    ))
    .map(({ id, slot, alias, alias5 }) => ({ id, slot, alias, alias5 }));
}

/**
 * Validiert eine vom Dashboard/API angeforderte Scope-ID strikt gegen Guild,
 * Status, Legacy-Regel und aktive Nitrado-Bindung. null = guild-global.
 */
export async function validateKnowledgeScope(
  guildId: string,
  nitradoConnId: string | null,
): Promise<KnowledgeScopeValidation> {
  if (nitradoConnId === null) {
    return {
      ok: true,
      scope: { type: 'GLOBAL', nitradoConnId: null, slot: null, alias: null, alias5: null },
    };
  }
  const id = nitradoConnId.trim();
  if (!id) return { ok: false, message: 'Gameserver-Scope ist ungueltig.' };
  const row = await prisma.nitradoConnection.findFirst({
    where: { id, guildId },
    select: { id: true, slot: true, alias: true, alias5: true, status: true, nitradoServerId: true },
  });
  if (!row) return { ok: false, message: 'Gameserver-Scope nicht gefunden oder gehoert zu einer anderen Guild.' };
  if (row.status !== 'ACTIVE') return { ok: false, message: 'Gameserver-Scope ist nicht aktiv.' };
  if (slotState(row.slot) !== 'ACTIVE_SLOT') return { ok: false, message: 'Legacy-Slot kann nicht als Knowledge-Scope verwendet werden.' };
  if (!row.nitradoServerId?.trim()) return { ok: false, message: 'Gameserver-Scope ist noch nicht an eine Nitrado-Service-ID gebunden.' };
  return {
    ok: true,
    scope: {
      type: 'GAMESERVER',
      nitradoConnId: row.id,
      slot: row.slot,
      alias: row.alias,
      alias5: row.alias5,
    },
  };
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function containsPhrase(question: string, phrase: string): boolean {
  const q = ` ${normalizeText(question)} `;
  const p = normalizeText(phrase);
  return p.length >= 4 && q.includes(` ${p} `);
}

/**
 * Runtime-Aufloesung fuer freien Discord-Chat.
 *
 * AI-13 Boundary:
 * 1. Explizites "slot N"/"server N"/"gameserver N" oder Alias/Alias5 -> exakt dieser Live-Scope.
 * 2. Genau ein produktiver Gameserver wird NUR bei klarer Live-Server-Intention automatisch gewaehlt.
 * 3. Allgemeine DayZ-/Vanilla-Fragen bleiben guild-global.
 * 4. Mehrere/mehrdeutige Server ohne eindeutige Auswahl -> guild-global.
 *
 * Es gibt bewusst KEIN implizites Slot-1-Fallback und niemals einen Mix aus
 * allgemeinem Wissen und Wissen mehrerer Gameserver.
 */
export async function resolveRuntimeKnowledgeScope(
  guildId: string,
  question: string,
): Promise<KnowledgeGameserverOption | null> {
  const options = await listKnowledgeGameservers(guildId);
  if (options.length === 0) return null;

  const normalized = normalizeText(question);
  const slotMatch = normalized.match(/\b(?:slot|server|gameserver)\s*([1-9])\b/);
  if (slotMatch) {
    const slot = Number(slotMatch[1]);
    const exact = options.filter((o) => o.slot === slot);
    return exact.length === 1 ? exact[0] : null;
  }

  const explicitMatches = options.filter((o) => {
    const alias5 = normalizeText(o.alias5);
    const alias5Hit = alias5.length === 5 && new RegExp(`(?:^|\\s)${alias5}(?:$|\\s)`, 'i').test(normalized);
    return alias5Hit || containsPhrase(question, o.alias);
  });
  if (explicitMatches.length === 1) return explicitMatches[0];
  if (explicitMatches.length > 1) return null;

  if (options.length === 1 && looksLikeLiveServerKnowledgeQuestion(question)) return options[0];
  return null;
}

export async function getKnowledgeScopeRows(
  guildId: string,
): Promise<Array<{ knowledgeId: string; nitradoConnId: string }>> {
  return prisma.guildKnowledgeScope.findMany({
    where: { guildId },
    select: { knowledgeId: true, nitradoConnId: true },
  });
}

/**
 * Filtert Kandidaten VOR dem Hybrid-Scoring.
 *
 * AI-13 macht die beiden Domains gegenseitig exklusiv:
 * - null => ausschliesslich guild-globales/allgemeines Wissen
 * - konkrete nitradoConnId => ausschliesslich Wissen exakt dieses Gameservers
 *
 * Dadurch kann ein globales/Vanilla-Snippet niemals das Ranking einer Live-
 * Serverfrage beeinflussen und umgekehrt.
 */
export function filterKnowledgeRowsForScope<T extends { id: string }>(
  rows: readonly T[],
  scopeRows: readonly { knowledgeId: string; nitradoConnId: string }[],
  nitradoConnId: string | null,
): T[] {
  const byKnowledge = new Map(scopeRows.map((s) => [s.knowledgeId, s.nitradoConnId] as const));
  return rows.filter((row) => {
    const scopedTo = byKnowledge.get(row.id);
    if (nitradoConnId === null) return !scopedTo;
    return scopedTo === nitradoConnId;
  });
}

export async function setKnowledgeScope(
  guildId: string,
  knowledgeId: string,
  nitradoConnId: string | null,
): Promise<KnowledgeScopeValidation> {
  const knowledge = await prisma.guildKnowledge.findUnique({ where: { id: knowledgeId }, select: { guildId: true } });
  if (!knowledge || knowledge.guildId !== guildId) return { ok: false, message: 'Snippet nicht gefunden.' };

  const validation = await validateKnowledgeScope(guildId, nitradoConnId);
  if (!validation.ok) return validation;
  if (validation.scope.type === 'GLOBAL') {
    await prisma.guildKnowledgeScope.deleteMany({ where: { knowledgeId, guildId } });
    return validation;
  }

  await prisma.guildKnowledgeScope.upsert({
    where: { knowledgeId },
    create: { knowledgeId, guildId, nitradoConnId: validation.scope.nitradoConnId! },
    update: { guildId, nitradoConnId: validation.scope.nitradoConnId! },
  });
  return validation;
}

export async function getKnowledgeAdminScopeMap(
  guildId: string,
): Promise<Map<string, KnowledgeScopeMeta>> {
  const [scopeRows, servers] = await Promise.all([
    getKnowledgeScopeRows(guildId),
    listKnowledgeGameservers(guildId),
  ]);
  const serverMap = new Map(servers.map((s) => [s.id, s] as const));
  const out = new Map<string, KnowledgeScopeMeta>();
  for (const row of scopeRows) {
    const server = serverMap.get(row.nitradoConnId);
    out.set(row.knowledgeId, {
      type: 'GAMESERVER',
      nitradoConnId: row.nitradoConnId,
      slot: server?.slot ?? null,
      alias: server?.alias ?? null,
      alias5: server?.alias5 ?? null,
    });
  }
  return out;
}

export function globalKnowledgeScope(): KnowledgeScopeMeta {
  return { type: 'GLOBAL', nitradoConnId: null, slot: null, alias: null, alias5: null };
}
