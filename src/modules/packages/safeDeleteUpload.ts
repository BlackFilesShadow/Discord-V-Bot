import fs from 'node:fs/promises';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { isInsideRoot, isInsideUploadRoot } from '../../utils/pathSafety';

export class SafeDeleteUploadError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
    this.name = 'SafeDeleteUploadError';
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

/**
 * Loescht eine einzelne Upload-Datei fail-closed.
 *
 * Die physische Datei wird erst nach lexikalischer + realpath-Pruefung entfernt.
 * Erst danach werden Upload-Status und Paketstatistik gemeinsam persistiert.
 * ENOENT ist retry-sicher; andere I/O-Fehler stoppen die DB-Mutation.
 */
export async function safeDeleteUpload(uploadId: string) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload || upload.isDeleted) {
    throw new SafeDeleteUploadError('Datei nicht gefunden oder bereits gelöscht.', 404);
  }
  if (!isInsideUploadRoot(upload.filePath)) {
    throw new SafeDeleteUploadError('Datei-Löschung blockiert: Pfad liegt ausserhalb des Upload-Root.', 409);
  }

  let realUploadRoot: string;
  try {
    realUploadRoot = await fs.realpath(config.upload.dir);
  } catch (error) {
    throw new SafeDeleteUploadError(
      `Datei-Löschung abgebrochen: Upload-Root konnte nicht aufgelöst werden (${errorCode(error) || 'I/O-Fehler'}).`,
      500,
    );
  }

  let alreadyMissing = false;
  try {
    const realFile = await fs.realpath(upload.filePath);
    if (!isInsideRoot(realFile, realUploadRoot)) {
      throw new SafeDeleteUploadError('Datei-Löschung blockiert: realer Pfad verlässt den Upload-Root.', 409);
    }
  } catch (error) {
    if (error instanceof SafeDeleteUploadError) throw error;
    if (errorCode(error) === 'ENOENT') alreadyMissing = true;
    else {
      throw new SafeDeleteUploadError(
        `Datei-Löschung abgebrochen: Pfad konnte nicht sicher aufgelöst werden (${errorCode(error) || 'I/O-Fehler'}).`,
        500,
      );
    }
  }

  if (!alreadyMissing) {
    try {
      const realFile = await fs.realpath(upload.filePath);
      if (!isInsideRoot(realFile, realUploadRoot)) {
        throw new SafeDeleteUploadError('Datei-Löschung blockiert: Pfad hat den Upload-Root nach Preflight verlassen.', 409);
      }
      await fs.unlink(upload.filePath);
    } catch (error) {
      if (error instanceof SafeDeleteUploadError) throw error;
      if (errorCode(error) === 'ENOENT') alreadyMissing = true;
      else {
        throw new SafeDeleteUploadError(
          `Datei-Löschung abgebrochen: Datei konnte nicht entfernt werden (${errorCode(error) || 'I/O-Fehler'}).`,
          500,
        );
      }
    }
  }

  await prisma.$transaction([
    prisma.upload.update({
      where: { id: upload.id },
      data: { isDeleted: true, deletedAt: new Date() },
    }),
    prisma.package.update({
      where: { id: upload.packageId },
      data: {
        fileCount: { decrement: 1 },
        totalSize: { decrement: upload.fileSize },
      },
    }),
  ]);

  return {
    id: upload.id,
    packageId: upload.packageId,
    originalName: upload.originalName,
    fileRemoved: !alreadyMissing,
    fileAlreadyMissing: alreadyMissing,
  };
}
