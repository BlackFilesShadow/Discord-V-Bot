import {
  LIVE_SERVER_KNOWLEDGE_CREATED_BY,
  liveServerSourcePrefixForConnection,
} from './liveServerKnowledgeConstants';

export interface LiveServerKnowledgeLifecycleClient {
  guildKnowledgeScope: {
    findMany(args: unknown): Promise<Array<{ knowledgeId: string }>>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  guildKnowledge: {
    findMany(args: unknown): Promise<Array<{ id: string }>>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  guildKnowledgeProvenance: {
    findMany(args: unknown): Promise<Array<{ knowledgeId: string }>>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

/**
 * Entfernt ausschliesslich systemgeneriertes LIVE_SERVER-Mirrorwissen fuer exakt
 * eine Guild + NitradoConnection. Owner-/Import-Wissen wird weder globalisiert
 * noch geloescht. Caller muessen fuer atomare Lifecycle-Mutationen einen
 * TransactionClient uebergeben.
 */
export async function deleteGeneratedLiveServerKnowledge(
  client: LiveServerKnowledgeLifecycleClient,
  guildId: string,
  nitradoConnId: string,
): Promise<number> {
  const scopedRows = await client.guildKnowledgeScope.findMany({
    where: { guildId, nitradoConnId },
    select: { knowledgeId: true },
  });
  const scopedIds = scopedRows.map((row) => row.knowledgeId);
  if (scopedIds.length === 0) return 0;

  const [systemRows, provenanceRows] = await Promise.all([
    client.guildKnowledge.findMany({
      where: {
        guildId,
        createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY,
        id: { in: scopedIds },
      },
      select: { id: true },
    }),
    client.guildKnowledgeProvenance.findMany({
      where: {
        guildId,
        knowledgeId: { in: scopedIds },
        sourceKind: 'LIVE_SERVER',
        sourceRef: { startsWith: liveServerSourcePrefixForConnection(nitradoConnId) },
      },
      select: { knowledgeId: true },
    }),
  ]);

  const provenanceIds = new Set(provenanceRows.map((row) => row.knowledgeId));
  const generatedIds = systemRows.map((row) => row.id).filter((id) => provenanceIds.has(id));
  if (generatedIds.length === 0) return 0;

  // FK-/Lifecycle-Reihenfolge: Provenance -> Scope -> Knowledge.
  await client.guildKnowledgeProvenance.deleteMany({
    where: { guildId, knowledgeId: { in: generatedIds } },
  });
  await client.guildKnowledgeScope.deleteMany({
    where: { guildId, knowledgeId: { in: generatedIds } },
  });
  await client.guildKnowledge.deleteMany({
    where: {
      guildId,
      id: { in: generatedIds },
      createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY,
    },
  });
  return generatedIds.length;
}
