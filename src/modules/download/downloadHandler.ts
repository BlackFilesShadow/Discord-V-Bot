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
 * Baut ein Archiv (zip|tar) aus den uebergebenen Dateien und streamt es
 * direkt auf die Platte (kein vollstaendiges Puffern im RAM -> kein
 * Memory-Exhaustion-DoS). Es werden ausschliesslich Dateien innerhalb des
 * Upload-Root aufgenommen (Path-Traversal-Schutz). Gibt den Pfad der
 * temporaeren Archivdatei zurueck.
 */
async function buildPackageArchive(
  files: { filePath: string; originalName: string }[],
  format: 'zip' | 'tar',
): Promise<{ archivePath: string; includedCount: number }> {
  const ext = format === 'zip' ? 'zip' : 'tar.gz';
  const archivePath = path.join(
    os.tmpdir(),
    `pkg-${crypto.randomBytes(8).toString('hex')}.${ext}`,
  );
  const output = fs.createWriteStream(archivePath);
  const archive =
    format === 'zip'
      ? archiver('zip', { zlib: { level: 9 } })
      : archiver('tar', { gzip: true });

  let includedCount = 0;
  archive.pipe(output);

  for (const file of files) {
    // P0: Nur Dateien innerhalb des Upload-Root archivieren. Ein
    // manipulierter DB-Pfad darf keine fremden Dateien einschleusen.
    if (!isInsideUploadRoot(file.filePath)) {
      logger.error(
        `Path traversal blocked beim Archivieren: ${file.filePath} ausserhalb Upload-Root.`,
      );
      continue;
    }
    if (fs.existsSync(file.filePath)) {
      archive.file(file.filePath, { name: file.originalName });
      includedCount++;
    }
  }

  // finalize() startet das Schreiben; wir warten auf das vollstaendige
  // Flushen der WriteStream-Datei.
  const done = new Promise<void>((resolve, reject) => {
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
  });
  await archive.finalize();
  await done;

  return { archivePath, includedCount };
}

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
  if (!isInsideUploadRoot(upload.filePath)) {
    logger.error(`Path traversal blocked: ${path.resolve(upload.filePath)} outside Upload-Root`);
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

  // Atomar: Download-Log + Counter (sonst Drift bei Teilfehler).
  await prisma.$transaction([
    prisma.download.create({
      data: {
        userId: downloaderUserId,
        packageId: upload.packageId,
        uploadId: upload.id,
        downloadType: 'SINGLE_FILE',
      },
    }),
    prisma.package.update({
      where: { id: upload.packageId },
      data: { downloadCount: { increment: 1 } },
    }),
  ]);

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
): Promise<{ success: boolean; filePath?: string; fileName?: string; message: string }> {
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

  // ZIP streamend auf Platte erstellen (Path-Traversal-Schutz + kein RAM-Buffer)
  const { archivePath, includedCount } = await buildPackageArchive(pkg.files, 'zip');
  if (includedCount === 0) {
    fs.promises.unlink(archivePath).catch(() => undefined);
    return { success: false, message: 'Paket enthält keine verfügbaren Dateien.' };
  }

  // Download-Tracking
  let downloaderUserId: string | null = null;
  if (downloaderDiscordId) {
    const user = await prisma.user.findUnique({ where: { discordId: downloaderDiscordId } });
    downloaderUserId = user?.id || null;
  }

  // Atomar: Download-Log + Counter (sonst Drift bei Teilfehler).
  await prisma.$transaction([
    prisma.download.create({
      data: {
        userId: downloaderUserId,
        packageId: pkg.id,
        downloadType: 'PACKAGE_ZIP',
      },
    }),
    prisma.package.update({
      where: { id: pkg.id },
      data: { downloadCount: { increment: 1 } },
    }),
  ]);

  logAudit('PACKAGE_DOWNLOADED', 'DOWNLOAD', {
    packageId: pkg.id,
    downloaderId: downloaderDiscordId,
    packageName: pkg.name,
    fileCount: includedCount,
    format: 'ZIP',
  });

  return {
    success: true,
    filePath: archivePath,
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
): Promise<{ success: boolean; filePath?: string; fileName?: string; message: string }> {
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

  // TAR streamend auf Platte erstellen (Path-Traversal-Schutz + kein RAM-Buffer)
  const { archivePath, includedCount } = await buildPackageArchive(pkg.files, 'tar');
  if (includedCount === 0) {
    fs.promises.unlink(archivePath).catch(() => undefined);
    return { success: false, message: 'Paket enthält keine verfügbaren Dateien.' };
  }

  let downloaderUserId: string | null = null;
  if (downloaderDiscordId) {
    const user = await prisma.user.findUnique({ where: { discordId: downloaderDiscordId } });
    downloaderUserId = user?.id || null;
  }

  // Atomar: Download-Log + Counter (sonst Drift bei Teilfehler).
  await prisma.$transaction([
    prisma.download.create({
      data: {
        userId: downloaderUserId,
        packageId: pkg.id,
        downloadType: 'PACKAGE_TAR',
      },
    }),
    prisma.package.update({
      where: { id: pkg.id },
      data: { downloadCount: { increment: 1 } },
    }),
  ]);

  logAudit('PACKAGE_DOWNLOADED', 'DOWNLOAD', {
    packageId: pkg.id,
    downloaderId: downloaderDiscordId,
    packageName: pkg.name,
    fileCount: includedCount,
    format: 'TAR',
  });

  return {
    success: true,
    filePath: archivePath,
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
