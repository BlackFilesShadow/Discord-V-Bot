import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { readBlob } from '../nitrado/mirror/storage';
import { validateKnowledgeScope } from './knowledgeScope';
import {
  LIVE_SERVER_KNOWLEDGE_CREATED_BY,
  LIVE_SERVER_VALIDITY_DAYS,
  liveServerSourcePrefixForConnection,
} from './liveServerKnowledgeConstants';
import {
  chooseLiveServerKnowledgeFiles,
  parseLiveServerKnowledgeFile,
  type LiveServerKnowledgeFileInput,
  type ParsedLiveServerKnowledgeDocument,
} from './liveServerKnowledgeParser';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;

export interface LiveServerKnowledgeIndexResult {
  snapshotId: string;
  nitradoConnId: string;
  parsedFiles: number;
  documents: number;
  replacedDocuments: number;
  skippedFiles: number;
}

type SnapshotTextFile = {
  path: string;
  name: string;
  sizeBytes: bigint;
  sha256: string | null;
  contentText: string | null;
  storedPath: string | null;
};

async function hydrateFile(file: SnapshotTextFile): Promise<(SnapshotTextFile & { content: string }) | null> {
  if (!file.sha256 || file.sizeBytes > BigInt(MAX_SOURCE_BYTES)) return null;
  if (typeof file.contentText === 'string') return { ...file, content: file.contentText };
  if (!file.storedPath) return null;
  try {
    const buf = await readBlob(file.storedPath);
    if (buf.length > MAX_SOURCE_BYTES) return null;
    return { ...file, content: buf.toString('utf8') };
  } catch (e) {
    logger.warn('[AI-14] Snapshot-Blob konnte nicht gelesen werden', { path: file.path, e: String(e) });
    return null;
  }
}

function sourceRef(nitradoConnId: string, document: ParsedLiveServerKnowledgeDocument): string {
  return `${liveServerSourcePrefixForConnection(nitradoConnId)}${encodeURIComponent(document.sourceKey)}`.slice(0, 500);
}

function sourceVersion(snapshotId: string, sha256: string): string {
  return `${snapshotId}:${sha256}`.slice(0, 100);
}

export async function indexNitradoSnapshotKnowledge(input: {
  snapshotId: string;
  guildId: string;
  nitradoConnId: string;
}): Promise<LiveServerKnowledgeIndexResult> {
  const scope = await validateKnowledgeScope(input.guildId, input.nitradoConnId);
  if (!scope.ok || scope.scope.type !== 'GAMESERVER') {
    throw new Error(scope.ok ? 'Live-Server-Knowledge erfordert Gameserver-Scope.' : scope.message);
  }

  const snapshot = await prisma.nitradoSnapshot.findFirst({
    where: {
      id: input.snapshotId,
      guildId: input.guildId,
      nitradoConnId: input.nitradoConnId,
      status: { in: ['OK', 'PARTIAL'] },
    },
    select: { id: true, finishedAt: true },
  });
  const observedAt = snapshot?.finishedAt ?? null;
  if (!snapshot || !observedAt) throw new Error('Snapshot ist nicht abgeschlossen oder nicht fuer Live-Knowledge geeignet.');

  const rows = await prisma.nitradoSnapshotFile.findMany({
    where: {
      snapshotId: input.snapshotId,
      isDir: false,
      isText: true,
      oversize: false,
      errorMsg: null,
    },
    select: {
      path: true,
      name: true,
      sizeBytes: true,
      sha256: true,
      contentText: true,
      storedPath: true,
    },
    orderBy: [{ path: 'asc' }],
  });

  const hydrated = (await Promise.all(rows.map((row) => hydrateFile(row as SnapshotTextFile))))
    .filter((row): row is SnapshotTextFile & { content: string } => Boolean(row));
  const chosen = chooseLiveServerKnowledgeFiles(hydrated);
  const documents: ParsedLiveServerKnowledgeDocument[] = [];
  for (const file of chosen) {
    const parsed = parseLiveServerKnowledgeFile({
      path: file.path,
      name: file.name,
      sha256: file.sha256!,
      content: file.content,
    } satisfies LiveServerKnowledgeFileInput);
    documents.push(...parsed);
  }

  const validUntil = new Date(observedAt.getTime() + LIVE_SERVER_VALIDITY_DAYS * 86_400_000);
  const prefix = liveServerSourcePrefixForConnection(input.nitradoConnId);

  const replacedDocuments = await prisma.$transaction(async (tx) => {
    const scopedRows = await tx.guildKnowledgeScope.findMany({
      where: { guildId: input.guildId, nitradoConnId: input.nitradoConnId },
      select: { knowledgeId: true },
    });
    const scopedIds = scopedRows.map((row) => row.knowledgeId);
    let generatedIds: string[] = [];
    if (scopedIds.length > 0) {
      const systemRows = await tx.guildKnowledge.findMany({
        where: {
          guildId: input.guildId,
          createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY,
          id: { in: scopedIds },
        },
        select: { id: true },
      });
      const provenanceRows = await tx.guildKnowledgeProvenance.findMany({
        where: {
          guildId: input.guildId,
          knowledgeId: { in: scopedIds },
          sourceKind: 'LIVE_SERVER',
          sourceRef: { startsWith: prefix },
        },
        select: { knowledgeId: true },
      });
      const provenanceIds = new Set(provenanceRows.map((row) => row.knowledgeId));
      generatedIds = systemRows.map((row) => row.id).filter((id) => provenanceIds.has(id));
    }

    if (generatedIds.length > 0) {
      await tx.guildKnowledgeProvenance.deleteMany({
        where: { guildId: input.guildId, knowledgeId: { in: generatedIds } },
      });
      await tx.guildKnowledgeScope.deleteMany({
        where: { guildId: input.guildId, knowledgeId: { in: generatedIds } },
      });
      await tx.guildKnowledge.deleteMany({
        where: { guildId: input.guildId, id: { in: generatedIds }, createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY },
      });
    }

    for (const document of documents) {
      const created = await tx.guildKnowledge.create({
        data: {
          guildId: input.guildId,
          label: document.label,
          content: document.content,
          createdBy: LIVE_SERVER_KNOWLEDGE_CREATED_BY,
        },
        select: { id: true },
      });
      await tx.guildKnowledgeScope.create({
        data: {
          knowledgeId: created.id,
          guildId: input.guildId,
          nitradoConnId: input.nitradoConnId,
        },
      });
      await tx.guildKnowledgeProvenance.create({
        data: {
          knowledgeId: created.id,
          guildId: input.guildId,
          sourceKind: 'LIVE_SERVER',
          trustLevel: 'VERIFIED',
          sourceRef: sourceRef(input.nitradoConnId, document),
          sourceVersion: sourceVersion(input.snapshotId, document.sha256),
          observedAt,
          validUntil,
        },
      });
    }
    return generatedIds.length;
  });

  const result: LiveServerKnowledgeIndexResult = {
    snapshotId: input.snapshotId,
    nitradoConnId: input.nitradoConnId,
    parsedFiles: chosen.length,
    documents: documents.length,
    replacedDocuments,
    skippedFiles: Math.max(0, rows.length - chosen.length),
  };
  logger.info('[AI-14] Live-Server-Knowledge indexiert', result);
  return result;
}
