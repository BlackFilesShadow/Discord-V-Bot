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
 * Upload-Handler (Sektion 2):
 * - Unbegrenzte Uploads pro Nutzer/GUID-Bereich
 * - Upload von beliebig vielen Dateien gleichzeitig als Paket
 * - Dateien (XML, JSON) bis 2 GB, Chunked-Upload
 * - Integritätsprüfung (Größe, Format, Hash, Validität)
 * - Validierungs-Feedback
 */

/**
 * Stellt sicher, dass der GUID-basierte Upload-Bereich existiert.
 * Sektion 1: GUID-basierte Bereichserstellung, keine Namenskonflikte.
 */
export function ensureUserUploadDir(userId: string): string {
  const userDir = path.join(config.upload.dir, userId);
  if (!existsSync(userDir)) {
    mkdirSync(userDir, { recursive: true });
  }
  return userDir;
}

/**
 * Prüft ob ein User Uploadrechte hat.
 * Sektion 1: Uploadrechte nur für eigenen GUID-Bereich.
 */
export async function checkUploadPermission(userId: string): Promise<{ allowed: boolean; reason?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
  });

  if (!user) {
    logger.warn(`checkUploadPermission DENIED: user ${userId} nicht gefunden`);
    return { allowed: false, reason: 'User nicht gefunden.' };
  }

  if (user.status !== 'ACTIVE') {
    logger.warn(`checkUploadPermission DENIED: user ${user.discordId} status=${user.status}`);
    return { allowed: false, reason: `Account nicht aktiv (Status: \`${user.status}\`).` };
  }

  if (!user.isManufacturer) {
    logger.warn(`checkUploadPermission DENIED: user ${user.discordId} role=${user.role} isManufacturer=${user.isManufacturer}`);
    return { allowed: false, reason: `Keine Upload-Berechtigung. Upload ist ausschlie\u00dflich der Rolle **Hersteller** vorbehalten. Registriere dich mit \`/register manufacturer\`.` };
  }

  return { allowed: true };
}

/**
 * Erstellt oder findet ein Paket für den Upload.
 * Sektion 2: Paketname frei wählbar, GUID-gebunden, keine Namenskonflikte.
 */
export async function getOrCreatePackage(userId: string, packageName: string, description?: string) {

  // STRIKT: Wenn bereits ein AKTIVES Paket mit gleichem Namen existiert,
  // wirf DuplicatePackageNameError. So bekommt der User eine klare Warnung
  // und Dateien landen NICHT versehentlich im falschen Paket.
  // Multi-File-Uploads innerhalb EINES /upload-Aufrufs muessen das Paket
  // genau einmal vor der Schleife anlegen und danach nur noch processUpload
  // mit der pkg.id verwenden.
  const existingActive = await prisma.package.findFirst({
    where: {
      userId,
      isDeleted: false,
      name: { equals: packageName, mode: 'insensitive' },
    },
  });
  if (existingActive) {
    throw new DuplicatePackageNameError(packageName);
  }

  // Soft-deleted Eintrag mit gleichem Namen? -> reaktivieren statt neu anlegen,
  // damit das @@unique([userId,name]) nicht verletzt wird. Der Slot ist frei,
  // weil das alte Paket geloescht wurde.
  const existingSoftDeleted = await prisma.package.findFirst({
    where: {
      userId,
      isDeleted: true,
      name: { equals: packageName, mode: 'insensitive' },
    },
  });
  if (existingSoftDeleted) {
    const restored = await prisma.package.update({
      where: { id: existingSoftDeleted.id },
      data: {
        isDeleted: false,
        deletedAt: null,
        deletedBy: null,
        status: 'ACTIVE',
        description: description ?? existingSoftDeleted.description,
        totalSize: BigInt(0),
        fileCount: 0,
      },
    });
    await prisma.upload.deleteMany({ where: { packageId: restored.id } });
    logAudit('PACKAGE_RESTORED_ON_UPLOAD', 'UPLOAD', { packageId: restored.id, userId, packageName });
    return restored;
  }

  // Race-Condition: ein zeitgleicher zweiter /upload mit demselben Namen
  // koennte den findFirst-Check umgehen. Der DB-seitige Partial-Unique-Index
  // idx_pkg_user_lower_name_active (deploy/sql/002_*.sql) faengt das ab und
  // liefert einen P2002-Fehler — wir werfen dann auch hier den Duplicate-Error
  // statt das vorhandene Paket zurueckzugeben.
  let pkg;
  try {
    pkg = await prisma.package.create({
      data: {
        userId,
        name: packageName,
        description,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      throw new DuplicatePackageNameError(packageName);
    }
    throw err;
  }

  logAudit('PACKAGE_CREATED', 'UPLOAD', {
    packageId: pkg.id,
    userId,
    packageName,
  });

  return pkg;
}

/**
 * Verarbeitet einen Datei-Upload.
 * Sektion 2: Integritätsprüfung, Validierung, Metadaten.
 */
export async function processUpload(
  userId: string,
  packageId: string,
  fileBuffer: Buffer,
  originalName: string,
  mimeType: string
): Promise<{
  success: boolean;
  uploadId?: string;
  validation?: Awaited<ReturnType<typeof validateFile>>;
  message: string;
}> {
  const ext = path.extname(originalName).toLowerCase();

  // Dateityp prüfen
  if (!config.upload.allowedExtensions.includes(ext)) {
    return {
      success: false,
      message: `Ungültiger Dateityp: ${ext}. Erlaubt: ${config.upload.allowedExtensions.join(', ')}`,
    };
  }

  // Dateigröße prüfen (Sektion 2: bis 2 GB)
  if (fileBuffer.length > config.upload.maxFileSizeBytes) {
    return {
      success: false,
      message: `Datei zu groß: ${formatBytes(fileBuffer.length)}. Maximum: ${formatBytes(config.upload.maxFileSizeBytes)}`,
    };
  }

  // SHA-256 Hash berechnen (Integritätsprüfung)
  const fileHash = sha256Hash(fileBuffer);

  // packageId & userId müssen UUID sein (verhindert Pfad-Injection)
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRe.test(userId) || !uuidRe.test(packageId)) {
    return { success: false, message: 'Ungültige User- oder Paket-ID.' };
  }

  // Dateiname generieren (sicher, keine Pfad-Traversal, keine Hidden-Files)
  const safeFileName = `${crypto.randomBytes(8).toString('hex')}_${sanitizeFilename(originalName)}`;
  const userDir = ensureUserUploadDir(userId);
  const packageDir = path.join(userDir, packageId);

  // Final-Path muss innerhalb der Upload-Root liegen
  const filePath = path.join(packageDir, safeFileName);
  if (!isPathSafe(filePath) || !isPathSafe(packageDir)) {
    logger.error(`Path-Traversal blockiert: ${filePath}`);
    return { success: false, message: 'Sicherheitsprüfung fehlgeschlagen.' };
  }

  // Erst in Staging-Verzeichnis schreiben — Virenscan vor Aktivierung
  const stagingDir = path.join(config.upload.dir, '.staging');
  if (!existsSync(stagingDir)) {
    mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  }
  const stagingPath = path.join(stagingDir, `${crypto.randomBytes(16).toString('hex')}_${safeFileName}`);
  await fs.writeFile(stagingPath, fileBuffer, { mode: 0o600 });

  // Virenscan VOR dem Move in den aktiven Bereich (Sektion 2)
  const scanResult = await scanFile(stagingPath, userId);
  if (!scanResult.clean) {
    // Datei aus Staging in Quarantäne verschieben — nie aktiv gewesen
    const quarantineDir = path.join(config.upload.dir, '.quarantine');
    if (!existsSync(quarantineDir)) {
      mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    }
    const quarantinePath = path.join(quarantineDir, `${Date.now()}_${safeFileName}`);
    try {
      await fs.rename(stagingPath, quarantinePath);
    } catch {
      try { await fs.unlink(stagingPath); } catch { /* */ }
    }

    logAudit('UPLOAD_QUARANTINED_VIRUS', 'SECURITY', {
      userId,
      originalName,
      threats: scanResult.threats,
      engine: scanResult.engine,
    });

    return {
      success: false,
      message: `Datei "${originalName}" wurde als verdächtig erkannt und in Quarantäne verschoben. Bedrohungen: ${scanResult.threats.join(', ')}`,
    };
  }

  // Scan ok — jetzt in aktiven Bereich verschieben
  if (!existsSync(packageDir)) {
    mkdirSync(packageDir, { recursive: true, mode: 0o755 });
  }
  await fs.rename(stagingPath, filePath);

  // Dateityp bestimmen
  const fileType = ext === '.xml' ? 'XML' : ext === '.json' ? 'JSON' : 'OTHER';

  // Upload in DB speichern
  const upload = await prisma.upload.create({
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

  // Paket-Statistiken aktualisieren
  await prisma.package.update({
    where: { id: packageId },
    data: {
      totalSize: { increment: BigInt(fileBuffer.length) },
      fileCount: { increment: 1 },
    },
  });

  // Validierung durchführen (Sektion 2: Hochmoderner XML- & JSON-Validator)
  let validationReport;
  try {
    validationReport = await validateFile(filePath);

    await prisma.upload.update({
      where: { id: upload.id },
      data: {
        isValid: validationReport.isValid,
        validationStatus: validationReport.isValid ? 'VALID' : 'INVALID',
      },
    });

    // Validierungsergebnis speichern
    await prisma.validationResult.create({
      data: {
        uploadId: upload.id,
        packageId,
        isValid: validationReport.isValid,
        errors: validationReport.errors as any,
        warnings: validationReport.warnings as any,
        suggestions: validationReport.suggestions as any,
        validatedBy: 'system',
      },
    });

    // Bei Verdacht: Quarantäne (Sektion 2)
    if (!validationReport.isValid && validationReport.errors.length > 3) {
      await prisma.upload.update({
        where: { id: upload.id },
        data: {
          isQuarantined: true,
          quarantineReason: 'Zu viele Validierungsfehler',
          validationStatus: 'QUARANTINED',
        },
      });
    }
  } catch (error) {
    logger.error('Validierungsfehler:', error);
    await prisma.upload.update({
      where: { id: upload.id },
      data: { validationStatus: 'ERROR' },
    });
  }

  logAudit('FILE_UPLOADED', 'UPLOAD', {
    uploadId: upload.id,
    userId,
    packageId,
    originalName,
    fileSize: fileBuffer.length,
    fileHash,
    fileType,
    isValid: validationReport?.isValid,
  });

  return {
    success: true,
    uploadId: upload.id,
    validation: validationReport,
    message: `Datei "${originalName}" erfolgreich hochgeladen.`,
  };
}

/**
 * Paket löschen (Soft-Delete, Restore möglich).
 * Sektion 2: Pakete können vom Nutzer/Admin gelöscht werden.
 */
export async function deletePackage(packageId: string, deletedBy: string, hard: boolean = false) {
  if (hard) {
    // Hard-Delete: Dateien und DB-Einträge entfernen
    const pkg = await prisma.package.findUnique({
      where: { id: packageId },
      include: { files: true },
    });

    if (pkg) {
      // Dateien vom Filesystem löschen
      for (const file of pkg.files) {
        try {
          await fs.unlink(file.filePath);
        } catch { /* Datei existiert möglicherweise nicht mehr */ }
      }

      await prisma.package.delete({ where: { id: packageId } });
    }
  } else {
    // Soft-Delete
    await prisma.package.update({
      where: { id: packageId },
      data: {
        isDeleted: true,
        deletedAt: new Date(),
        deletedBy,
        status: 'DELETED',
      },
    });

    await prisma.upload.updateMany({
      where: { packageId },
      data: { isDeleted: true, deletedAt: new Date() },
    });
  }

  logAudit(hard ? 'PACKAGE_HARD_DELETED' : 'PACKAGE_SOFT_DELETED', 'UPLOAD', {
    packageId,
    deletedBy,
  });
}

/**
 * Paket wiederherstellen (Sektion 2: Restore möglich).
 */
export async function restorePackage(packageId: string) {
  await prisma.package.update({
    where: { id: packageId },
    data: {
      isDeleted: false,
      deletedAt: null,
      deletedBy: null,
      status: 'ACTIVE',
    },
  });

  await prisma.upload.updateMany({
    where: { packageId },
    data: { isDeleted: false, deletedAt: null },
  });

  logAudit('PACKAGE_RESTORED', 'UPLOAD', { packageId });
}

/**
 * Sanitize Dateiname (Sicherheit: keine Pfad-Traversal, keine Hidden-Files).
 */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+/, '_')           // keine führenden Punkte (.htaccess, .env)
    .replace(/[._-]+$/, '')         // keine trailing dots/underscores
    .substring(0, 200);
  // Fallback falls leer nach Sanitize
  return cleaned || `file_${Date.now()}`;
}

/**
 * Prüft, ob ein Pfad sicher unterhalb der Upload-Root liegt.
 */
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
    super(`Du hast bereits ein Paket mit dem Namen "${name}". Bitte wähle einen anderen Namen.`);
    this.name = 'DuplicatePackageNameError';
  }
}
