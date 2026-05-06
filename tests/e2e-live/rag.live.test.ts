/**
 * Live-E2E: RAG-Antwort-Pipeline.
 *
 * SKIP-BY-DEFAULT — siehe tests/e2e-live/README.md.
 *
 * Dieser Test verifiziert NUR die State-fuer-State-Verkettung:
 *   1. KnowledgeEntry mit eindeutigem Marker in DB einfuegen
 *   2. embeddingService.embed() → vector existiert
 *   3. RAG-Retrieval-Query → Marker-Eintrag MUSS unter Top-3 sein
 *   4. Aufraeumen
 *
 * Discord-Round-trip ist hier bewusst nicht enthalten — der ist im killfeed.live
 * abgedeckt und der RAG-Pfad selbst ist transport-agnostisch.
 */

const LIVE = process.env.ENABLE_LIVE_E2E === '1';
const HAS_DB = !!process.env.DATABASE_URL && /test/i.test(process.env.DATABASE_URL ?? '');

const describeLive = LIVE && HAS_DB ? describe : describe.skip;

describeLive('RAG live-pipeline', () => {
  // Lazy imports — keine Side-effects wenn skipped.
  let prisma: any;
  let embedFn: (text: string) => Promise<number[]>;

  const marker = `__live_e2e__rag_${Date.now()}`;
  let entryId: string | null = null;

  beforeAll(async () => {
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient();
    const embeddings: any = await import('../../src/modules/ai/embeddings.js');
    // generateEmbedding -> Promise<Embedding|null>; auf Float-Array reduzieren
    embedFn = async (text: string) => {
      const e = await embeddings.generateEmbedding(text);
      if (!e) throw new Error('embedding generation returned null');
      return Array.isArray(e) ? e : (e.values ?? e.vector ?? e);
    };
  }, 30_000);

  afterAll(async () => {
    if (entryId && prisma) {
      await prisma.knowledgeEntry?.delete({ where: { id: entryId } }).catch(() => { /* */ });
    }
    if (prisma) await prisma.$disconnect();
  });

  it('seedet KnowledgeEntry, ruft Top-3 ab und findet Marker', async () => {
    const text = `Geheimer Marker fuer E2E: ${marker}. Der V-Bot wurde am 6. Mai 2026 in Hetzner produktiv gesetzt.`;
    const vec = await embedFn(text);
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.length).toBeGreaterThan(100);

    // Insert (best-effort, falls Schema KnowledgeEntry mit embedding-Feld hat)
    const created = await prisma.knowledgeEntry.create({
      data: {
        guildId: process.env.TEST_GUILD_ID ?? 'live_e2e_dummy_guild',
        content: text,
        tags: ['__live_e2e__'],
        // pgvector-Feld kommt direkt als Float-Array
        embedding: vec as any,
      },
    });
    entryId = created.id;

    // Retrieval ueber pgvector cosine-distance (Top-3)
    const queryVec = await embedFn('Wann wurde der V-Bot produktiv?');
    const rows: Array<{ id: string; content: string; distance: number }> =
      await prisma.$queryRawUnsafe(
        `SELECT id, content, embedding <=> $1::vector AS distance
         FROM "KnowledgeEntry"
         WHERE '__live_e2e__' = ANY(tags)
         ORDER BY distance ASC LIMIT 3`,
        queryVec,
      );

    expect(rows.length).toBeGreaterThan(0);
    const found = rows.find((r) => r.content.includes(marker));
    expect(found).toBeDefined();
  }, 60_000);
});
