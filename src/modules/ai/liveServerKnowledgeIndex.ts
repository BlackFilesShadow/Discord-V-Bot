import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import {
  withFreshAdmBinding,
  type AdmBindingSnapshot,
} from '../nitrado/adm/bindingFence';
import { readBlob } from '../nitrado/mirror/storage';
import {
  countDayzValidationIssues,
  validateDayzKnowledgeSet,
  type DayzConfigValidationResult,
} from './dayzConfigValidation';
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
  type LiveServerKnowledgeKind,
  type ParsedLiveServerKnowledgeDocument,
} from './liveServerKnowledgeParser';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_VALIDATION_ISSUES_PER_FILE = 200;

export interface LiveServerKnowledgeIndexResult {
  snapshotId: string;
  nitradoConnId: string;
  parsedFiles: number;
  documents: number;
  replacedDocuments: number;
  skippedFiles: number;
  validationErrors: number;
  validationWarnings: number;
  rejectedFiles: number;
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

function sourceVersion(bindingVersion: number, snapshotId: string, sha256: string): string {
  return `b${bindingVersion}:${snapshotId}:${sha256}`.slice(0, 100);
}

function validationKind(fileName: string): LiveServerKnowledgeKind {
  switch (fileName.toLowerCase()) {
    case 'cfggameplay.json': return 'GAMEPLAY_JSON';
    case 'types.xml': return 'TYPES_XML';
    case 'events.xml': return 'EVENTS_XML';
    case 'globals.xml': return 'GLOBALS_XML';
    case 'cfgweather.xml': return 'WEATHER_XML';
    case 'cfgspawnabletypes.xml': return 'SPAWNABLE_TYPES_XML';
    default: return 'SERVER_CONFIG';
  }
}

function validationDocument(
  file: SnapshotTextFile & { content: string },
  validation: DayzConfigValidationResult,
): ParsedLiveServerKnowledgeDocument | null {
  if (validation.issues.length === 0 || !file.sha256) return null;
  const errors = validation.issues.filter((issue) => issue.severity === 'ERROR').length;
  const warnings = validation.issues.filter((issue) => issue.severity === 'WARNING').length;
  const status = validation.validForKnowledge ? 'VALID_WITH_WARNINGS' : 'INVALID';
  const lines = [
    `LIVE_SERVER VALIDATION ${validation.fileName}`,
    'deterministic=true',
    `status=${status}`,
    `syntaxValid=${validation.syntaxValid}`,
    `errors=${errors}`,
    `warnings=${warnings}`,
    ...validation.issues.slice(0, MAX_VALIDATION_ISSUES_PER_FILE).map((issue) =>
      `issue severity=${issue.severity} | code=${issue.code} | path=${issue.path} | message=${issue.message}`,
    ),
  ];
  return {
    kind: validationKind(validation.fileName),
    label: `Live Validation ${validation.fileName}`.slice(0, 60),
    sourceKey: `validation/${validation.fileName}`,
    sourceName: validation.fileName,
    sha256: file.sha256,
    content: lines.join('\n'),
  };
}

export async function indexNitradoSnapshotKnowledge(input: {
  snapshotId: string;
  guildId: string;
  nitradoConnId: string;
  binding: AdmBindingSnapshot;
}): Promise<LiveServerKnowledgeIndexResult> {
  // Nitrado-1R: Ein Caller darf niemals einen Snapshot/Scope mit einem fremden
  // oder spaeter zusammengesetzten Binding-Snapshot kombinieren.
  if (input.binding.id !== input.nitradoConnId || input.binding.guildId !== input.guildId) {
    throw new Error('Live-Server-Knowledge Binding stimmt nicht mit Guild/Gameserver-Scope ueberein.');
  }

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
    select: { id: true, serviceId: true, finishedAt: true },
  });
  const observedAt = snapshot?.finishedAt ?? null;
  if (!snapshot || !observedAt) throw new Error('Snapshot ist nicht abgeschlossen oder nicht fuer Live-Knowledge geeignet.');
  if (snapshot.serviceId !== input.binding.nitradoServerId) {
    throw new Error('Snapshot gehoert nicht zur erwarteten Nitrado-Service-Bindung.');
  }

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

  // AI-15: XML/JSON wird deterministisch validiert, bevor irgendein normalisierter
  // Wert als VERIFIED LIVE_SERVER-Knowledge in den LLM/RAG-Pfad gelangen kann.
  // Fehlerhafte Dateien liefern ausschliesslich einen deterministischen Diagnoseblock.
  const validationResults = validateDayzKnowledgeSet(chosen.map((file) => ({
    path: file.path,
    name: file.name,
    content: file.content,
  })));
  const validationTotals = countDayzValidationIssues(validationResults.values());

  const documents: ParsedLiveServerKnowledgeDocument[] = [];
  let parsedFiles = 0;
  for (const file of chosen) {
    const validation = validationResults.get(file.path);
    if (validation) {
      const report = validationDocument(file, validation);
      if (report) documents.push(report);
      if (!validation.validForKnowledge) continue;
    }

    const parsed = parseLiveServerKnowledgeFile({
      path: file.path,
      name: file.name,
      sha256: file.sha256!,
      content: file.content,
    } satisfies LiveServerKnowledgeFileInput);
    if (parsed.length > 0) parsedFiles += 1;
    documents.push(...parsed);
  }

  const validUntil = new Date(observedAt.getTime() + LIVE_SERVER_VALIDITY_DAYS * 86_400_000);
  const prefix = liveServerSourcePrefixForConnection(input.nitradoConnId);

  // Die komplette lokale Austausch-Transaktion liegt unter der finalen
  // Token-/Service-/Binding-Freshness-Grenze. Ein X->Y->X-ABA-Servicewechsel
  // verliert wegen bindingVersion ebenso wie ein Tokenwechsel den Fence.
  const replacedDocuments = await withFreshAdmBinding(input.binding, () => prisma.$transaction(async (tx) => {
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
          sourceVersion: sourceVersion(input.binding.bindingVersion, input.snapshotId, document.sha256),
          observedAt,
          validUntil,
        },
      });
    }
    return generatedIds.length;
  }));

  const result: LiveServerKnowledgeIndexResult = {
    snapshotId: input.snapshotId,
    nitradoConnId: input.nitradoConnId,
    parsedFiles,
    documents: documents.length,
    replacedDocuments,
    skippedFiles: Math.max(0, rows.length - chosen.length),
    validationErrors: validationTotals.errors,
    validationWarnings: validationTotals.warnings,
    rejectedFiles: validationTotals.rejectedFiles,
  };
  logger.info('[AI-15] Live-Server-Knowledge deterministisch validiert und indexiert', result);
  return result;
}
