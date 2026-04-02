import prisma from '../../database/prisma';
import { config } from '../../config';
import { logger, logAudit } from '../../utils/logger';
import { checkRateLimit } from '../../utils/rateLimiter';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { Writable } from 'stream';

/**
 * Download-Handler (Sektion 3):
 * - Download von Einzeldateien oder kompletten Paketen (ZIP, TAR)
 * - Download global für alle Nutzer
 * - Download-Tracking, Rate-Limit, Abuse-Detection
 */

/**
 * Einzeldatei-Download.
 */
export async function downloadSingleFile(
  uploadId: string,
  downloaderDiscordId?: string
): Promise<{ success: boolean; filePath?: string; fileName?: string; message: string }> {
  const upload = await prisma.upload.findUnique({
    where: { id: uploadId },
    include: { package: true },
  });

  if (!upload || upload.isDeleted) {
    return { success: false, message: 'Datei nicht gefunden.' };
  }

  if (upload.package.isDeleted) {
    return { success: false, message: 'Paket wurde gelöscht.' };
  }

  if (upload.isQuarantined) {
    return { success: false, message: 'Datei ist in Quarantäne.' };
  }

  // Datei existiert auf Filesystem?
  if (!fs.existsSync(upload.filePath)) {
    return { success: false, message: 'Datei nicht mehr verfügbar.' };
  }

  // Sicherheitscheck: Pfad darf nicht außerhalb des Upload-Verzeichnisses liegen
  const resolvedPath = path.resolve(upload.filePath);
  const uploadRoot = path.resolve(config.upload.dir);
  if (!resolvedPath.startsWith(uploadRoot)) {
    logger.error(`Path traversal blocked: ${resolvedPath} outside ${uploadRoot}`);
    return { success: false, message: 'Dateizugriff verweigert.' };
  }

  // Rate-Limit prüfen
  if (downloaderDiscordId) {
    const rl = await checkRateLimit(downloaderDiscordId, 'download');
    if (!rl.allowed) {
      return { success: false, message: 'Download Rate-Limit erreicht. Bitte warte.' };
    }
  }

  // Download-Tracking
  let downloaderUserId: string | null = null;
  if (downloaderDiscordId) {
    const user = await prisma.user.findUnique({ where: { discordId: downloaderDiscordId } });
    downloaderUserId = user?.id || null;
  }

  await prisma.download.create({
    data: {
      userId: downloaderUserId,
      packageId: upload.packageId,
      uploadId: upload.id,
      downloadType: 'SINGLE_FILE',
    },
  });

  // Paket Download-Counter erhöhen
  await prisma.package.update({
    where: { id: upload.packageId },
    data: { downloadCount: { increment: 1 } },
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

/**
 * Paket-Download (alle Dateien als ZIP).
 * Sektion 3: Download von kompletten Paketen.
 */
export async function downloadPackageAsZip(
  packageId: string,
  downloaderDiscordId?: string
): Promise<{ success: boolean; zipBuffer?: Buffer; fileName?: string; message: string }> {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: {
      files: {
        where: { isDeleted: false, isQuarantined: false },
      },
      user: true,
    },
  });

  if (!pkg || pkg.isDeleted) {
    return { success: false, message: 'Paket nicht gefunden.' };
  }

  if (pkg.files.length === 0) {
    return { success: false, message: 'Paket enthält keine Dateien.' };
  }

  // Rate-Limit prüfen
  if (downloaderDiscordId) {
    const rl = await checkRateLimit(downloaderDiscordId, 'download');
    if (!rl.allowed) {
      return { success: false, message: 'Download Rate-Limit erreicht. Bitte warte.' };
    }
  }

  // ZIP erstellen
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _, callback) {
      chunks.push(chunk);
      callback();
    },
  });

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.pipe(writable);

  for (const file of pkg.files) {
    if (fs.existsSync(file.filePath)) {
      archive.file(file.filePath, { name: file.originalName });
    }
  }

  await archive.finalize();

  // Warten bis der Stream fertig ist
  await new Promise<void>((resolve, reject) => {
    writable.on('finish', resolve);
    writable.on('error', reject);
  });

  const zipBuffer = Buffer.concat(chunks);

  // Download-Tracking
  let downloaderUserId: string | null = null;
  if (downloaderDiscordId) {
    const user = await prisma.user.findUnique({ where: { discordId: downloaderDiscordId } });
    downloaderUserId = user?.id || null;
  }

  await prisma.download.create({
    data: {
      userId: downloaderUserId,
      packageId: pkg.id,
      downloadType: 'PACKAGE_ZIP',
    },
  });

  await prisma.package.update({
    where: { id: pkg.id },
    data: { downloadCount: { increment: 1 } },
  });

  logAudit('PACKAGE_DOWNLOADED', 'DOWNLOAD', {
    packageId: pkg.id,
    downloaderId: downloaderDiscordId,
    packageName: pkg.name,
    fileCount: pkg.files.length,
    format: 'ZIP',
  });

  return {
    success: true,
    zipBuffer,
    fileName: `${pkg.name}.zip`,
    message: 'Download bereit.',
  };
}

/**
 * Paket-Download als TAR-Archiv.
 * Sektion 3: Unterstützung für TAR-Format.
 */
export async function downloadPackageAsTar(
  packageId: string,
  downloaderDiscordId?: string
): Promise<{ success: boolean; tarBuffer?: Buffer; fileName?: string; message: string }> {
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: {
      files: {
        where: { isDeleted: false, isQuarantined: false },
      },
      user: true,
    },
  });

  if (!pkg || pkg.isDeleted) {
    return { success: false, message: 'Paket nicht gefunden.' };
  }

  if (pkg.files.length === 0) {
    return { success: false, message: 'Paket enthält keine Dateien.' };
  }

  if (downloaderDiscordId) {
    const rl = await checkRateLimit(downloaderDiscordId, 'download');
    if (!rl.allowed) {
      return { success: false, message: 'Download Rate-Limit erreicht. Bitte warte.' };
    }
  }

  // TAR erstellen (archiver unterstützt 'tar' format)
  const chunks: Buffer[] = [];
  const writable = new Writable({
    write(chunk, _, callback) {
      chunks.push(chunk);
      callback();
    },
  });

  const archive = archiver('tar', { gzip: true });
  archive.pipe(writable);

  for (const file of pkg.files) {
    if (fs.existsSync(file.filePath)) {
      archive.file(file.filePath, { name: file.originalName });
    }
  }

  await archive.finalize();

  await new Promise<void>((resolve, reject) => {
    writable.on('finish', resolve);
    writable.on('error', reject);
  });

  const tarBuffer = Buffer.concat(chunks);

  let downloaderUserId: string | null = null;
  if (downloaderDiscordId) {
    const user = await prisma.user.findUnique({ where: { discordId: downloaderDiscordId } });
    downloaderUserId = user?.id || null;
  }

  await prisma.download.create({
    data: {
      userId: downloaderUserId,
      packageId: pkg.id,
      downloadType: 'PACKAGE_TAR',
    },
  });

  await prisma.package.update({
    where: { id: pkg.id },
    data: { downloadCount: { increment: 1 } },
  });

  logAudit('PACKAGE_DOWNLOADED', 'DOWNLOAD', {
    packageId: pkg.id,
    downloaderId: downloaderDiscordId,
    packageName: pkg.name,
    fileCount: pkg.files.length,
    format: 'TAR',
  });

  return {
    success: true,
    tarBuffer,
    fileName: `${pkg.name}.tar.gz`,
    message: 'Download bereit.',
  };
}

/**
 * Suche nach Paketen (Sektion 3: Suche nach Paketnamen, Dateityp oder Nutzer).
 */
export async function searchPackages(query: string, options?: {
  fileType?: string;
  userId?: string;
  limit?: number;
  offset?: number;
}) {
  const where: any = {
    isDeleted: false,
    OR: [
      { name: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
      { user: { username: { contains: query, mode: 'insensitive' } } },
    ],
  };

  if (options?.fileType) {
    where.files = {
      some: { fileType: options.fileType.toUpperCase(), isDeleted: false },
    };
  }

  if (options?.userId) {
    where.userId = options.userId;
  }

  const packages = await prisma.package.findMany({
    where,
    include: {
      user: { select: { username: true, discordId: true } },
      _count: { select: { files: true, downloads: true } },
    },
    take: options?.limit || 20,
    skip: options?.offset || 0,
    orderBy: { downloadCount: 'desc' },
  });

  return packages;
}
