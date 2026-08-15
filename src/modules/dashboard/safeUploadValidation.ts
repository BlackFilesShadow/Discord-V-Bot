import fs from 'node:fs/promises';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { isInsideRoot, isInsideUploadRoot } from '../../utils/pathSafety';
import { withTimeout } from '../../utils/safeSend';
import { validateFile } from '../../utils/validator';

const MAX_VALIDATE_BYTES = 50 * 1024 * 1024;
const VALIDATE_TIMEOUT_MS = 30_000;

export class SafeUploadValidationError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
    this.name = 'SafeUploadValidationError';
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : undefined;
}

export async function safeValidateUpload(uploadId: string, validatedBy: string) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) throw new SafeUploadValidationError('Upload nicht gefunden.', 404);

  if (!isInsideUploadRoot(upload.filePath)) {
    throw new SafeUploadValidationError('Validierung blockiert: Dateipfad liegt ausserhalb des Upload-Root.', 409);
  }

  let realUploadRoot: string;
  let realFile: string;
  try {
    realUploadRoot = await fs.realpath(config.upload.dir);
  } catch (error) {
    throw new SafeUploadValidationError(
      `Upload-Root konnte nicht sicher aufgeloest werden (${errorCode(error) || 'I/O-Fehler'}).`,
      500,
    );
  }
  try {
    realFile = await fs.realpath(upload.filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new SafeUploadValidationError('Datei auf dem Server nicht gefunden.', 404);
    throw new SafeUploadValidationError(
      `Dateipfad konnte nicht sicher aufgeloest werden (${errorCode(error) || 'I/O-Fehler'}).`,
      500,
    );
  }
  if (!isInsideRoot(realFile, realUploadRoot)) {
    throw new SafeUploadValidationError('Validierung blockiert: realer Dateipfad verlaesst den Upload-Root.', 409);
  }

  let stat;
  try {
    stat = await fs.stat(realFile);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') throw new SafeUploadValidationError('Datei auf dem Server nicht gefunden.', 404);
    throw new SafeUploadValidationError(
      `Datei-Metadaten konnten nicht gelesen werden (${errorCode(error) || 'I/O-Fehler'}).`,
      500,
    );
  }
  if (!stat.isFile()) throw new SafeUploadValidationError('Upload-Pfad verweist nicht auf eine regulaere Datei.', 409);
  if (stat.size > MAX_VALIDATE_BYTES) {
    throw new SafeUploadValidationError('Datei zu groß (>50 MB) für On-Demand-Validierung.', 413);
  }

  let validation: Awaited<ReturnType<typeof validateFile>> | null;
  try {
    validation = await withTimeout(validateFile(realFile), VALIDATE_TIMEOUT_MS, `dashboardValidate:${uploadId}`);
  } catch (error) {
    throw new SafeUploadValidationError(
      `Validator-Fehler: ${String(error instanceof Error ? error.message : error).slice(0, 300)}`,
      500,
    );
  }
  if (!validation) throw new SafeUploadValidationError('Validierung Timeout.', 504);

  await prisma.$transaction([
    prisma.upload.update({
      where: { id: upload.id },
      data: {
        isValid: validation.isValid,
        validationStatus: validation.isValid ? 'VALID' : 'INVALID',
      },
    }),
    prisma.validationResult.create({
      data: {
        uploadId: upload.id,
        packageId: upload.packageId,
        isValid: validation.isValid,
        errors: JSON.parse(JSON.stringify(validation.errors)),
        warnings: JSON.parse(JSON.stringify(validation.warnings)),
        suggestions: JSON.parse(JSON.stringify(validation.suggestions)),
        validatedBy,
      },
    }),
  ]);

  return {
    id: upload.id,
    name: upload.originalName,
    isValid: validation.isValid,
    errors: validation.errors,
    warnings: validation.warnings,
    suggestions: validation.suggestions,
  };
}
