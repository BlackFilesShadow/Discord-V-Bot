import fs from 'node:fs/promises';
import prisma from '../../database/prisma';
import { isInsideUploadRoot } from '../../utils/pathSafety';
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

export async function safeValidateUpload(uploadId: string, validatedBy: string) {
  const upload = await prisma.upload.findUnique({ where: { id: uploadId } });
  if (!upload) throw new SafeUploadValidationError('Upload nicht gefunden.', 404);

  if (!isInsideUploadRoot(upload.filePath)) {
    throw new SafeUploadValidationError('Validierung blockiert: Dateipfad liegt ausserhalb des Upload-Root.', 409);
  }

  const stat = await fs.stat(upload.filePath).catch(() => null);
  if (!stat) throw new SafeUploadValidationError('Datei auf dem Server nicht gefunden.', 404);
  if (stat.size > MAX_VALIDATE_BYTES) {
    throw new SafeUploadValidationError('Datei zu groß (>50 MB) für On-Demand-Validierung.', 413);
  }

  let validation: Awaited<ReturnType<typeof validateFile>> | null;
  try {
    validation = await withTimeout(validateFile(upload.filePath), VALIDATE_TIMEOUT_MS, `dashboardValidate:${uploadId}`);
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
