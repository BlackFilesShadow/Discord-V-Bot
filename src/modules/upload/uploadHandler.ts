import prisma from '../../database/prisma';
import { config } from '../../config';
import { sha256Hash } from '../../utils/security';
import { validateFile } from '../../utils/validator';
import { logger, logAudit } from '../../utils/logger';
import { scanFile } from '../security/virusScanner';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import crypto from 'crypto';

/**
 * Upload-Handler.
 *
 * Produktions-Invarianten:
 * - Uploadrechte gelten nur fuer kanonisch aktive Hersteller:
 *   status=ACTIVE + isManufacturer=true + role=MANUFACTURER.
 * - `processUpload` prueft selbst, dass packageId wirklich dem userId gehoert
 *   und aktiv ist. Ein anderer Caller kann diese Mandantengrenze nicht umgehen.
 * - Upload-DB-Zeile + Paketzaehler werden atomar committed.
 * - Scheitert der DB-Commit nach dem File-Move, wird die neue Datei wieder
 *   entfernt. Es bleiben keine bewusst erzeugten Orphan-Dateien zurueck.
 * - Paket-Restore/Delete halten Paket- und Datei-Flags transaktional zusammen.
 */

export function ensureUserUploadDir(userId: string): string {
  const userDir = path.join(config.upload.dir, userId);
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true, mode: 0o755 });
  }
  return userDir;
}

export async function checkUploadPermission(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    logger.warn(`checkUploadPermission DENIED: user ${userId} nicht gefunden`);
    return { allowed: false, reason: 'User nicht gefunden.' };
  }
  if (user.status !== 'ACTIVE') {
    logger.warn(`checkUploadPermission DENIED: user ${user.discordId} status=${user.status}`);
    return { allowed: false, reason: `Account nicht aktiv (Status: \`${user.status}\`).` };
  }
  if (!user.isManufacturer || user.role !== 'MANUFACTURER') {
    logger.warn(`checkUploadPermission DENIED: user ${user.discordId} role=${user.role} isManufacturer=${user.isManufacturer}`);
    return {
      allowed: false,
      reason: 'Keine Upload-Berechtigung. Upload ist ausschliesslich vollstaendig verifizierten Herstellern vorbehalten. Registriere dich mit `/register manufacturer`.',
    };
  }
  return { allowed: true };
}

export async function getOrCreatePackage(userId: string, packageName: string, description?: string) {
  const normalizedName = packageName.trim();
  if (!normalizedName || normalizedName.length > 120) {
    throw new Error('Paketname muss zwischen 1 und 120 Zeichen lang sein.');
  }

  const existingActive = await prisma.package.findFirst({
    where: {
      userId,
      isDeleted: false,
      name: { equals: normalizedName, mode: 'insensitive' },
    },
  });
  if (existingActive) throw new DuplicatePackageNameError(normalizedName);

  const existingSoftDeleted = await prisma.package.findFirst({
    where: {
      userId,
      isDeleted: true,
      name: { equals: normalizedName, mode: 'insensitive' },
    },
  });

  if (existingSoftDeleted) {
    const restored = await prisma.$transaction(async tx => {
      const oldFiles = await tx.upload.findMany({
        where: { packageId: existingSoftDeleted.id, userId },
        select: { filePath: true },
      });
      const changed = await tx.package.updateMany({
        where: { id: existingSoftDeleted.id, userId, isDeleted: true },
        data: {
          isDeleted: false,
          deletedAt: null,
          deletedBy: null,
          status: 'ACTIVE',
          description: description ?? existingSoftDeleted.description,
          totalSize: 0n,
          fileCount: 0,
        },
      });
      if (changed.count !== 1) throw new DuplicatePackageNameError(normalizedName);
      await tx.upload.deleteMany({ where: { packageId: existingSoftDeleted.id, userId } });
      const pkg = await tx.package.findUnique({ where: { id: existingSoftDeleted.id } });
      if (!pkg) throw new Error('Paket-Restore konnte nicht bestaetigt werden.');
      return { pkg, oldFilePaths: oldFiles.map(file => file.filePath) };
    });

    // Dateisystem erst nach DB-Commit bereinigen. Fehler erzeugen nur
    // unreferenzierte Altdateien, niemals kaputte DB-Referenzen.
    for (const filePath of restored.oldFilePaths) {
      if (!isPathSafe(filePath)) continue;
      try { await fs.unlink(filePath); } catch { /* best effort */ }
    }

    logAudit('PACKAGE_RESTORED_ON_UPLOAD', 'UPLOAD', {
      packageId: restored.pkg.id,
      userId,
      packageName: normalizedName,
    });
    return restored.pkg;
  }

  try {
    const pkg = await prisma.package.create({
      data: { userId, name: normalizedName, description },
    });
    logAudit('PACKAGE_CREATED', 'UPLOAD', {
      packageId: pkg.id,
      userId,
      packageName: normalizedName,
    });
    return pkg;
  } catch (err: unknown) {
    if ((err as { code?: string })?.code === 'P2002') {
      throw new DuplicatePackageNameError(normalizedName);
    }
    throw err;
  }
}

export async function processUpload(
  userId: string,
  packageId: string,
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string,
): Promise<{
  success: boolean;
  uploadId?: string;
  validation?: Awaited<ReturnType<typeof validateFile>>;
  message: string;
}> {
  const ext = path.extname(originalName).toLowerCase();
  if (!config.upload.allowedExtensions.includes(ext)) {
    return {
      success: false,
      message: `Ungueltiger Dateityp: ${ext}. Erlaubt: ${config.upload.allowedExtensions.join(', ')}`,
    };
  }
  if (fileBuffer.length > config.upload.maxFileSizeBytes) {
    return {
      success: false,
      message: `Datei zu gross: ${formatBytes(fileBuffer.length)}. Maximum: ${formatBytes(config.upload.maxFileSizeBytes)}`,
    };
  }

  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(userId) || !uuidRe.test(packageId)) {
    return { success: false, message: 'Ungueltige User- oder Paket-ID.' };
  }

  // Service-seitige Ownership-Grenze. Nicht darauf vertrauen, dass jeder
  // kuenftige Caller vorher richtig scoped.
  const ownedPackage = await prisma.package.findFirst({
    where: { id: packageId, userId, isDeleted: false, status: 'ACTIVE' },
    select: { id: true },
  });
  if (!ownedPackage) {
    logAudit('UPLOAD_PACKAGE_SCOPE_DENIED', 'SECURITY', { userId, packageId });
    return { success: false, message: 'Paket nicht gefunden oder gehoert nicht zu deinem Herstellerbereich.' };
  }

  const permission = await checkUploadPermission(userId);
  if (!permission.allowed) return { success: false, message: permission.reason ?? 'Keine Upload-Berechtigung.' };

  const fileHash = sha256Hash(fileBuffer);
  const safeFileName = `${crypto.randomBytes(8).toString('hex')}_${sanitizeFilename(originalName)}`;
  const userDir = ensureUserUploadDir(userId);
  const packageDir = path.join(userDir, packageId);
  const filePath = path.join(packageDir, safeFileName);
  if (!isPathSafe(filePath) || !isPathSafe(packageDir)) {
    logger.error(`Path-Traversal blockiert: ${filePath}`);
    return { success: false, message: 'Sicherheitspruefung fehlgeschlagen.' };
  }

  const stagingDir = path.join(config.upload.dir, '.staging');
  if (!existsSync(stagingDir)) mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  const stagingPath = path.join(stagingDir, `${crypto.randomBytes(16).toString('hex')}_${safeFileName}`);
  await fs.writeFile(stagingPath, fileBuffer, { mode: 0o600 });

  let movedToActive = false;
  try {
    const scanResult = await scanFile(stagingPath, userId);
    if (!scanResult.clean) {
      const quarantineDir = path.join(config.upload.dir, '.quarantine');
      if (!existsSync(quarantineDir)) mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
      const quarantinePath = path.join(quarantineDir, `${Date.now()}_${safeFileName}`);
      try { await fs.rename(stagingPath, quarantinePath); }
      catch { try { await fs.unlink(stagingPath); } catch { /* best effort */ } }

      logAudit('UPLOAD_QUARANTINED_VIRUS', 'SECURITY', {
        userId,
        originalName,
        threats: scanResult.threats,
        engine: scanResult.engine,
      });
      return {
        success: false,
        message: `Datei "${originalName}" wurde als verdaechtig erkannt und in Quarantaene verschoben.`,
      };
    }

    if (!existsSync(packageDir)) mkdirSync(packageDir, { recursive: true, mode: 0o755 });
    await fs.rename(stagingPath, filePath);
    movedToActive = true;

    const fileType = ext === '.xml' ? 'XML' : ext === '.json' ? 'JSON' : 'OTHER';
    const upload = await prisma.$transaction(async tx => {
      const row = await tx.upload.create({
        data: {
          userId,
          packageId,
          fileName: safeFileName,
          originalName,
          filePath,
          fileSize: BigInt(fileBuffer.length),
          mimeType,
          fileHash,
          fileType,
          validationStatus: 'PENDING',
        },
      });
      const packageChanged = await tx.package.updateMany({
        where: { id: packageId, userId, isDeleted: false, status: 'ACTIVE' },
        data: {
          totalSize: { increment: BigInt(fileBuffer.length) },
          fileCount: { increment: 1 },
        },
      });
      if (packageChanged.count !== 1) {
        throw new Error('Paket wurde waehrend des Uploads entfernt oder gehoert nicht mehr zum Hersteller.');
      }
      return row;
    });

    let validationReport: Awaited<ReturnType<typeof validateFile>> | undefined;
    try {
      validationReport = await validateFile(filePath);
      const quarantined = !validationReport.isValid && validationReport.errors.length > 3;
      await prisma.$transaction(async tx => {
        await tx.upload.update({
          where: { id: upload.id },
          data: {
            isValid: validationReport!.isValid,
            isQuarantined: quarantined,
            quarantineReason: quarantined ? 'Zu viele Validierungsfehler' : null,
            validationStatus: quarantined
              ? 'QUARANTINED'
              : validationReport!.isValid ? 'VALID' : 'INVALID',
          },
        });
        await tx.validationResult.create({
          data: {
            uploadId: upload.id,
            packageId,
            isValid: validationReport!.isValid,
            errors: validationReport!.errors as any,
            warnings: validationReport!.warnings as any,
            suggestions: validationReport!.suggestions as any,
            validatedBy: 'system',
          },
        });
      });
    } catch (error) {
      logger.error('Validierungsfehler:', error);
      await prisma.upload.update({
        where: { id: upload.id },
        data: { isValid: false, validationStatus: 'ERROR' },
      }).catch(updateError => logger.error('Upload-Validierungsstatus konnte nicht auf ERROR gesetzt werden:', updateError));
    }

    logAudit('FILE_UPLOADED', 'UPLOAD', {
      uploadId: upload.id,
      userId,
      packageId,
      originalName,
      fileSize: fileBuffer.length,
      fileHash,
      fileType,
      isValid: validationReport?.isValid ?? false,
    });

    return {
      success: true,
      uploadId: upload.id,
      validation: validationReport,
      message: validationReport?.isValid
        ? `Datei "${originalName}" erfolgreich hochgeladen und validiert.`
        : `Datei "${originalName}" wurde hochgeladen, ist aber nicht fuer die oeffentliche Verteilung freigegeben.`,
    };
  } catch (error) {
    // Nur neue, noch nicht sicher referenzierte Datei entfernen. Falls der DB-
    // Commit bereits erfolgreich war und erst die spaetere Validierung Fehler
    // war, wird dieser Catch nicht erreicht, weil sie oben abgefangen wird.
    if (movedToActive) {
      try { await fs.unlink(filePath); } catch { /* best effort */ }
    } else {
      try { await fs.unlink(stagingPath); } catch { /* best effort */ }
    }
    throw error;
  }
}

export async function deletePackage(packageId: string, deletedBy: string, hard: boolean = false) {
  if (hard) {
    const pkg = await prisma.package.findUnique({
      where: { id: packageId },
      include: { files: { select: { filePath: true } } },
    });
    if (!pkg) return;

    // DB zuerst finalisieren. Erst danach Filesystem best-effort bereinigen.
    await prisma.package.delete({ where: { id: packageId } });
    for (const file of pkg.files) {
      if (!isPathSafe(file.filePath)) continue;
      try { await fs.unlink(file.filePath); } catch { /* best effort */ }
    }
  } else {
    const now = new Date();
    await prisma.$transaction(async tx => {
      const changed = await tx.package.updateMany({
        where: { id: packageId, isDeleted: false },
        data: {
          isDeleted: true,
          deletedAt: now,
          deletedBy,
          status: 'DELETED',
        },
      });
      if (changed.count !== 1) throw new Error('Paket nicht gefunden oder bereits geloescht.');
      await tx.upload.updateMany({
        where: { packageId, isDeleted: false },
        data: { isDeleted: true, deletedAt: now },
      });
    });
  }

  logAudit(hard ? 'PACKAGE_HARD_DELETED' : 'PACKAGE_SOFT_DELETED', 'UPLOAD', {
    packageId,
    deletedBy,
  });
}

export async function restorePackage(packageId: string) {
  await prisma.$transaction(async tx => {
    const changed = await tx.package.updateMany({
      where: { id: packageId, isDeleted: true },
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        status: 'ACTIVE',
      },
    });
    if (changed.count !== 1) throw new Error('Geloeschtes Paket nicht gefunden.');
    await tx.upload.updateMany({
      where: { packageId, isDeleted: true },
      data: { isDeleted: false, deletedAt: null },
    });
  });
  logAudit('PACKAGE_RESTORED', 'UPLOAD', { packageId });
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '_')
    .replace(/[._-]+$/, '')
    .substring(0, 200);
  return cleaned || `file_${Date.now()}`;
}

function isPathSafe(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const root = path.resolve(config.upload.dir);
  return resolved === root || resolved.startsWith(root + path.sep);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

export class DuplicatePackageNameError extends Error {
  constructor(name: string) {
    super(`Du hast bereits ein Paket mit dem Namen "${name}". Bitte waehle einen anderen Namen.`);
    this.name = 'DuplicatePackageNameError';
  }
}
