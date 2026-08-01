/**
 * ADM-Ingest-Service (Phase 3, Schritt 3) — die EINE Stelle, die ADM-Inhalte in
 * kanonische AdmEvents ueberfuehrt. Laedt den byte-genauen AdmSourceCursor,
 * verarbeitet nur neue Bytes und persistiert Events + Cursor atomar.
 *
 * Bewusst OHNE direkte Geldbuchung — Rewards laufen getrennt ueber die
 * RewardEngine (Shadow/WOULD_PAY). Der Parser bucht niemals Geld.
 */
import crypto from 'crypto';
import prisma from '../../../database/prisma';
import { ingestFullFile, persistAdmEvents, type AdmEventScope, type AdmSourceMeta, type AdmPersistClient } from './serverLogIngestor';

export interface AdmFileInput {
  fileName: string;
  modifiedAt: number; // Unix-Sekunden
  size: number;
  content: string;
}

/** Stabile Dateiidentitaet. ADM-Dateinamen sind zeitgestempelt eindeutig. */
export function fileIdentityFor(fileName: string): string {
  return fileName;
}

export async function ingestAdmFile(
  scope: AdmEventScope,
  file: AdmFileInput,
): Promise<{ inserted: number; newOffset: number; wasReset: boolean }> {
  const fileIdentity = fileIdentityFor(file.fileName);
  const cursor = await prisma.admSourceCursor.findUnique({
    where: { guildId_nitradoConnId_fileIdentity: { guildId: scope.guildId, nitradoConnId: scope.nitradoConnId, fileIdentity } },
  });
  const startOffset = cursor ? Number(cursor.processedByteOffset) : 0;

  const result = ingestFullFile(file.content, startOffset, { fileName: file.fileName });
  const fingerprint = crypto.createHash('sha256').update(file.content.slice(0, 4096)).digest('hex');
  const meta: AdmSourceMeta = {
    fileIdentity, fileName: file.fileName, lastModifiedAt: file.modifiedAt, fileSize: file.size,
  };
  const { inserted } = await persistAdmEvents(prisma as unknown as AdmPersistClient, scope, meta, result, fingerprint);
  return { inserted, newOffset: result.newOffset, wasReset: result.wasReset };
}
