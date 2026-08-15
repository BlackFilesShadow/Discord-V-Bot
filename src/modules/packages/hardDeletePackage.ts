import fs from 'node:fs/promises';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { isInsideRoot, isInsideUploadRoot } from '../../utils/pathSafety';

export interface HardDeletePackageResult {
  filesRemoved: number;
  filesAlreadyMissing: number;
}

export interface HardDeletePackageOptions {
  requireSoftDeleted?: boolean;
}

export class HardDeletePackageError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
    this.name = 'HardDeletePackageError';
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

/**
 * Physischer Paket-Delete fuer produktive Admin-Pfade.
 *
 * Reihenfolge ist absichtlich fail-closed:
 * 1. Paket + alle Dateipfade laden.
 * 2. Optional: fuer Purge-/Papierkorb-Pfade bestaetigen, dass das Paket beim
 *    Service-Read noch soft-geloescht ist.
 * 3. ALLE Pfade zuerst lexikalisch UND danach ueber realpath gegen den realen
 *    Upload-Root validieren. Das schliesst auch Symlink-/Junction-Escapes.
 * 4. Dateien entfernen; ENOENT ist idempotent/tolerierbar, andere I/O-Fehler
 *    brechen ab und lassen den DB-Datensatz fuer Diagnose/Retry bestehen.
 * 5. Erst wenn das Filesystem konsistent bereinigt ist, DB-Cascade ausfuehren.
 *
 * Falls der DB-Delete nach erfolgreichem Filesystem-Cleanup scheitert, bleibt
 * der Datensatz bestehen. Ein Retry ist sicher, weil ENOENT akzeptiert wird.
 */
export async function hardDeletePackage(
  packageId: string,
  options: HardDeletePackageOptions = {},
): Promise<HardDeletePackageResult> {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: { files: { select: { filePath: true } } },
  });
  if (!pkg) throw new HardDeletePackageError('Paket nicht gefunden.', 404);
  if (options.requireSoftDeleted && !pkg.isDeleted) {
    throw new HardDeletePackageError('Hard-Delete blockiert: Paket ist nicht mehr als geloescht markiert.', 409);
  }

  const unsafe = pkg.files.find(file => !isInsideUploadRoot(file.filePath));
  if (unsafe) {
    throw new HardDeletePackageError('Hard-Delete blockiert: Dateipfad liegt ausserhalb des Upload-Root.', 409);
  }

  let realUploadRoot: string;
  try {
    realUploadRoot = await fs.realpath(config.upload.dir);
  } catch (error) {
    throw new HardDeletePackageError(
      `Hard-Delete abgebrochen: Upload-Root konnte nicht aufgeloest werden (${errorCode(error) || 'I/O-Fehler'}).`,
      500,
    );
  }

  const missing = new Set<string>();
  for (const file of pkg.files) {
    try {
      const realFile = await fs.realpath(file.filePath);
      if (!isInsideRoot(realFile, realUploadRoot)) {
        throw new HardDeletePackageError('Hard-Delete blockiert: realer Dateipfad verlaesst den Upload-Root.', 409);
      }
    } catch (error) {
      if (error instanceof HardDeletePackageError) throw error;
      if (errorCode(error) === 'ENOENT') {
        missing.add(file.filePath);
        continue;
      }
      throw new HardDeletePackageError(
        `Hard-Delete abgebrochen: Dateipfad konnte nicht sicher aufgeloest werden (${errorCode(error) || 'I/O-Fehler'}).`,
        500,
      );
    }
  }

  let filesRemoved = 0;
  let filesAlreadyMissing = missing.size;
  for (const file of pkg.files) {
    if (missing.has(file.filePath)) continue;
    try {
      // Direkt vor dem Unlink erneut real aufloesen, um eine nach dem Preflight
      // ausgetauschte Symlink-Kette moeglichst fail-closed zu erkennen.
      const realFile = await fs.realpath(file.filePath);
      if (!isInsideRoot(realFile, realUploadRoot)) {
        throw new HardDeletePackageError('Hard-Delete blockiert: Dateipfad hat den Upload-Root nach Preflight verlassen.', 409);
      }
      await fs.unlink(file.filePath);
      filesRemoved += 1;
    } catch (error) {
      if (error instanceof HardDeletePackageError) throw error;
      if (errorCode(error) === 'ENOENT') {
        filesAlreadyMissing += 1;
        continue;
      }
      throw new HardDeletePackageError(
        `Hard-Delete abgebrochen: Datei konnte nicht entfernt werden (${errorCode(error) || 'I/O-Fehler'}).`,
        500,
      );
    }
  }

  await prisma.package.delete({ where: { id: packageId } });
  return { filesRemoved, filesAlreadyMissing };
}
