import fs from 'node:fs/promises';
import prisma from '../../database/prisma';
import { isInsideUploadRoot } from '../../utils/pathSafety';

export interface HardDeletePackageResult {
  filesRemoved: number;
  filesAlreadyMissing: number;
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
 * 2. ALLE Pfade validieren, bevor auch nur eine Datei geloescht wird.
 * 3. Dateien entfernen; ENOENT ist idempotent/tolerierbar, andere I/O-Fehler
 *    brechen ab und lassen den DB-Datensatz fuer Diagnose/Retry bestehen.
 * 4. Erst wenn das Filesystem konsistent bereinigt ist, DB-Cascade ausfuehren.
 *
 * Falls der DB-Delete nach erfolgreichem Filesystem-Cleanup scheitert, bleibt
 * der Datensatz bestehen. Ein Retry ist sicher, weil ENOENT akzeptiert wird.
 */
export async function hardDeletePackage(packageId: string): Promise<HardDeletePackageResult> {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: { files: { select: { filePath: true } } },
  });
  if (!pkg) throw new HardDeletePackageError('Paket nicht gefunden.', 404);

  const unsafe = pkg.files.find(file => !isInsideUploadRoot(file.filePath));
  if (unsafe) {
    throw new HardDeletePackageError('Hard-Delete blockiert: Dateipfad liegt ausserhalb des Upload-Root.', 409);
  }

  let filesRemoved = 0;
  let filesAlreadyMissing = 0;
  for (const file of pkg.files) {
    try {
      await fs.unlink(file.filePath);
      filesRemoved += 1;
    } catch (error) {
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
