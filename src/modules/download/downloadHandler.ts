import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { checkRateLimit } from '../../utils/rateLimiter';
import { isInsideUploadRoot } from '../../utils/pathSafety';
import archiver from 'archiver';
import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Oeffentliche Download-Grenze:
 * - Hersteller muss kanonisch verifiziert sein:
 *   ACTIVE + isManufacturer=true + role=MANUFACTURER.
 * - Paket muss ACTIVE und nicht geloescht sein.
 * - Datei muss VALID, isValid=true, nicht geloescht und nicht quarantiniert sein.
 *
 * Diese Checks liegen bewusst im Service und nicht nur im Slash-Command, damit
 * Dashboard, Suche oder kuenftige interne Caller keine schlechtere Freigabe-
 * Semantik bekommen koennen.
 */

function isPublicManufacturer(user: {
  status: string;
  isManufacturer: boolean;
  role: string;
}): boolean {
  return user.status === 'ACTIVE' && user.isManufacturer && user.role === 'MANUFACTURER';
}

function publicFileWhere(fileType?: string): Record<string, unknown> {
  return {
    isDeleted: false,
    isQuarantined: false,
    isValid: true,
    validationStatus: 'VALID',
    ...(fileType ? { fileType: fileType.toUpperCase() } : {}),
  };
}

async function buildPackageArchive(
  files: { filePath: string; originalName: string }[],
  format: 'zip' | 'tar',
): Promise<{ archivePath: string; includedCount: number }> {
  const ext = format === 'zip' ? 'zip' : 'tar.gz';
  const archivePath = path.join(os.tmpdir(), `pkg-${crypto.randomBytes(8).toString('hex')}.${ext}`);
  const output = fs.createWriteStream(archivePath);
  const archive = format === 'zip'
    ? archiver('zip', { zlib: { level: 9 } })
    : archiver('tar', { gzip: true });

  let includedCount = 0;
  archive.pipe(output);

  for (const file of files) {
    if (!isInsideUploadRoot(file.filePath)) {
      logger.error(`Path traversal blocked beim Archivieren: ${file.filePath} ausserhalb Upload-Root.`);
      continue;
    }
    if (fs.existsSync(file.filePath)) {
      archive.file(file.filePath, { name: file.originalName });
      includedCount++;
    }
  }

  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  try {
    await archive.finalize();
    await done;
    return { archivePath, includedCount };
  } catch (error) {
    fs.promises.unlink(archivePath).catch(() => undefined);
    throw error;
  }
}

async function downloaderUserId(discordId?: string): Promise<string | null> {
  if (!discordId) return null;
  const user = await prisma.user.findUnique({
    where: { discordId },
    select: { id: true },
  });
  return user?.id ?? null;
}

async function checkDownloadRateLimit(discordId?: string): Promise<boolean> {
  if (!discordId) return true;
  const rl = await checkRateLimit(discordId, 'download');
  return rl.allowed;
}

export async function downloadSingleFile(
  uploadId: string,
  downloaderDiscordId?: string,
): Promise<{ success: boolean; filePath?: string; fileName?: string; message: string }> {
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    include: {
      package: {
        include: {
          user: {
            select: { status: true, isManufacturer: true, role: true },
          },
        },
      },
    },
  });

  if (!upload || upload.isDeleted) return { success: false, message: 'Datei nicht gefunden.' };
  if (upload.package.isDeleted || upload.package.status !== 'ACTIVE') {
    return { success: false, message: 'Paket ist nicht oeffentlich verfuegbar.' };
  }
  if (!isPublicManufacturer(upload.package.user)) {
    return { success: false, message: 'Hersteller ist nicht mehr fuer oeffentliche Downloads freigegeben.' };
  }
  if (upload.isQuarantined) return { success: false, message: 'Datei ist in Quarantaene.' };
  if (!upload.isValid || upload.validationStatus !== 'VALID') {
    return { success: false, message: 'Datei ist nicht erfolgreich validiert und deshalb nicht oeffentlich freigegeben.' };
  }
  if (!fs.existsSync(upload.filePath)) return { success: false, message: 'Datei nicht mehr verfuegbar.' };
  if (!isInsideUploadRoot(upload.filePath)) {
    logger.error(`Path traversal blocked: ${path.resolve(upload.filePath)} outside Upload-Root`);
    return { success: false, message: 'Dateizugriff verweigert.' };
  }
  if (!(await checkDownloadRateLimit(downloaderDiscordId))) {
    return { success: false, message: 'Download Rate-Limit erreicht. Bitte warte.' };
  }

  const userId = await downloaderUserId(downloaderDiscordId);
  await prisma.$transaction(async tx => {
    // Re-check direkt im Tracking-Commit: Paket darf zwischen Lookup und
    // Auslieferung nicht geloescht worden sein.
    const packageStillActive = await tx.package.findFirst({
      where: { id: upload.packageId, isDeleted: false, status: 'ACTIVE' },
      select: { id: true },
    });
    if (!packageStillActive) throw new Error('Paket wurde waehrend des Downloads deaktiviert.');
    await tx.download.create({
      data: {
        userId,
        packageId: upload.packageId,
        uploadId: upload.id,
        downloadType: 'SINGLE_FILE',
      },
    });
    await tx.package.update({
      where: { id: upload.packageId },
      data: { downloadCount: { increment: 1 } },
    });
  });

  logAudit('FILE_DOWNLOADED', 'DOWNLOAD', {
    uploadId: upload.id,
    downloaderId: downloaderDiscordId,
    fileName: upload.originalName,
  });

  return {
    success: true,
    filePath: upload.filePath,
    fileName: upload.originalName,
    message: 'Download bereit.',
  };
}

type ArchiveFormat = 'zip' | 'tar';

async function downloadPackageArchive(
  packageId: string,
  format: ArchiveFormat,
  downloaderDiscordId?: string,
): Promise<{ success: boolean; filePath?: string; fileName?: string; message: string }> {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: {
      files: { where: publicFileWhere() as never },
      user: { select: { status: true, isManufacturer: true, role: true } },
    },
  });

  if (!pkg || pkg.isDeleted || pkg.status !== 'ACTIVE') {
    return { success: false, message: 'Paket nicht gefunden oder nicht oeffentlich freigegeben.' };
  }
  if (!isPublicManufacturer(pkg.user)) {
    return { success: false, message: 'Hersteller ist nicht mehr fuer oeffentliche Downloads freigegeben.' };
  }
  if (pkg.files.length === 0) {
    return { success: false, message: 'Paket enthaelt keine erfolgreich validierten Dateien.' };
  }
  if (!(await checkDownloadRateLimit(downloaderDiscordId))) {
    return { success: false, message: 'Download Rate-Limit erreicht. Bitte warte.' };
  }

  const { archivePath, includedCount } = await buildPackageArchive(pkg.files, format);
  if (includedCount === 0) {
    fs.promises.unlink(archivePath).catch(() => undefined);
    return { success: false, message: 'Paket enthaelt keine verfuegbaren Dateien.' };
  }

  const userId = await downloaderUserId(downloaderDiscordId);
  try {
    await prisma.$transaction(async tx => {
      const stillPublic = await tx.package.findFirst({
        where: {
          id: pkg.id,
          isDeleted: false,
          status: 'ACTIVE',
          user: { status: 'ACTIVE', isManufacturer: true, role: 'MANUFACTURER' },
        },
        select: { id: true },
      });
      if (!stillPublic) throw new Error('Paket wurde waehrend des Downloads deaktiviert.');
      await tx.download.create({
        data: {
          userId,
          packageId: pkg.id,
          downloadType: format === 'zip' ? 'PACKAGE_ZIP' : 'PACKAGE_TAR',
        },
      });
      await tx.package.update({
        where: { id: pkg.id },
        data: { downloadCount: { increment: 1 } },
      });
    });
  } catch (error) {
    fs.promises.unlink(archivePath).catch(() => undefined);
    throw error;
  }

  logAudit('PACKAGE_DOWNLOADED', 'DOWNLOAD', {
    packageId: pkg.id,
    downloaderId: downloaderDiscordId,
    packageName: pkg.name,
    fileCount: includedCount,
    format: format.toUpperCase(),
  });

  return {
    success: true,
    filePath: archivePath,
    fileName: format === 'zip' ? `${pkg.name}.zip` : `${pkg.name}.tar.gz`,
    message: 'Download bereit.',
  };
}

export async function downloadPackageAsZip(
  packageId: string,
  downloaderDiscordId?: string,
): Promise<{ success: boolean; filePath?: string; fileName?: string; message: string }> {
  return downloadPackageArchive(packageId, 'zip', downloaderDiscordId);
}

export async function downloadPackageAsTar(
  packageId: string,
  downloaderDiscordId?: string,
): Promise<{ success: boolean; filePath?: string; fileName?: string; message: string }> {
  return downloadPackageArchive(packageId, 'tar', downloaderDiscordId);
}

export async function searchPackages(query: string, options?: {
  fileType?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}) {
  const fileFilter = publicFileWhere(options?.fileType);
  const where: any = {
    isDeleted: false,
    status: 'ACTIVE',
    user: {
      status: 'ACTIVE',
      isManufacturer: true,
      role: 'MANUFACTURER',
    },
    files: { some: fileFilter },
    OR: [
      { name: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
      { user: { username: { contains: query, mode: 'insensitive' } } },
    ],
  };
  if (options?.userId) where.userId = options.userId;

  return prisma.package.findMany({
    where,
    include: {
      user: { select: { username: true, discordId: true } },
      _count: {
        select: {
          files: { where: fileFilter as never },
          downloads: true,
        },
      },
    },
    take: Math.min(Math.max(options?.limit ?? 20, 1), 100),
    skip: Math.max(options?.offset ?? 0, 0),
    orderBy: { downloadCount: 'desc' },
  });
}
