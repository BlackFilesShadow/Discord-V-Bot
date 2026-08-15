import { Router, type Request } from 'express';
import prisma from '../../../database/prisma';
import { requireBotAdmin } from '../../middleware/auth';
import { logAudit, logAuditDb } from '../../../utils/logger';
import { safeValidateUpload, SafeUploadValidationError } from '../../../modules/dashboard/safeUploadValidation';
import { hardDeletePackage, HardDeletePackageError } from '../../../modules/packages/hardDeletePackage';
import { safeDeleteUpload, SafeDeleteUploadError } from '../../../modules/packages/safeDeleteUpload';

export const botAdminCommandCenterSafetyRouter = Router();
botAdminCommandCenterSafetyRouter.use(requireBotAdmin);

function actor(req: Request): string {
  return String(req.auth?.discordId ?? req.auth?.userId ?? 'dashboard');
}

function audit(req: Request, action: string, details: Record<string, unknown>): void {
  const by = actor(req);
  logAudit(action, 'ADMIN', { ...details, by });
  logAuditDb(action, 'ADMIN', {
    actorUserId: req.auth?.userId ?? null,
    details,
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });
}

function statusOf(error: unknown): number {
  if (error instanceof SafeUploadValidationError || error instanceof HardDeletePackageError || error instanceof SafeDeleteUploadError) {
    return error.status;
  }
  return 500;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'Unbekannter Fehler.';
}

botAdminCommandCenterSafetyRouter.post('/validate/package/:id', async (req, res) => {
  const packageId = String(req.params.id ?? '');
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    include: { files: { select: { id: true } } },
  });
  if (!pkg) {
    res.status(404).json({ error: 'Paket nicht gefunden.' });
    return;
  }

  const results: Array<Record<string, unknown>> = [];
  for (const file of pkg.files) {
    try {
      results.push({ ok: true, ...(await safeValidateUpload(file.id, actor(req))) });
    } catch (error) {
      results.push({
        ok: false,
        id: file.id,
        status: statusOf(error),
        error: messageOf(error),
      });
    }
  }

  audit(req, 'BOTADMIN_PACKAGE_REVALIDATED', {
    packageId,
    files: results.length,
    invalid: results.filter(result => result.ok !== true || result.isValid === false).length,
  });
  res.json({ packageId, results });
});

botAdminCommandCenterSafetyRouter.post('/validate/upload/:id', async (req, res) => {
  try {
    const result = await safeValidateUpload(String(req.params.id ?? ''), actor(req));
    audit(req, 'BOTADMIN_FILE_REVALIDATED', { uploadId: result.id, isValid: result.isValid });
    res.json(result);
  } catch (error) {
    res.status(statusOf(error)).json({ error: messageOf(error) });
  }
});

botAdminCommandCenterSafetyRouter.delete('/uploads/:id', async (req, res) => {
  try {
    const result = await safeDeleteUpload(String(req.params.id ?? ''));
    audit(req, 'BOTADMIN_FILE_DELETE', {
      uploadId: result.id,
      packageId: result.packageId,
      fileRemoved: result.fileRemoved,
      fileAlreadyMissing: result.fileAlreadyMissing,
    });
    res.json({ deleted: true, ...result });
  } catch (error) {
    res.status(statusOf(error)).json({ error: messageOf(error) });
  }
});

botAdminCommandCenterSafetyRouter.delete('/packages/:id/hard', async (req, res) => {
  if (req.body?.confirm !== 'DELETE') {
    res.status(400).json({ error: 'Bestätigung DELETE erforderlich.' });
    return;
  }
  try {
    const packageId = String(req.params.id ?? '');
    const result = await hardDeletePackage(packageId);
    audit(req, 'BOTADMIN_PACKAGE_HARD_DELETE', { packageId, ...result });
    res.json({ deleted: true, ...result });
  } catch (error) {
    res.status(statusOf(error)).json({ error: messageOf(error) });
  }
});

botAdminCommandCenterSafetyRouter.post('/users/:id/packages/delete', async (req, res) => {
  const userId = String(req.params.id ?? '');
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) {
    res.status(404).json({ error: 'Nutzer nicht gefunden.' });
    return;
  }

  const hard = req.body?.hard === true;
  if (hard && req.body?.confirm !== 'DELETE') {
    res.status(400).json({ error: 'Bestätigung DELETE erforderlich.' });
    return;
  }

  const packages = await prisma.package.findMany({ where: { userId }, select: { id: true } });
  let filesRemoved = 0;
  let filesAlreadyMissing = 0;

  if (hard) {
    for (const pkg of packages) {
      try {
        const result = await hardDeletePackage(pkg.id);
        filesRemoved += result.filesRemoved;
        filesAlreadyMissing += result.filesAlreadyMissing;
      } catch (error) {
        audit(req, 'BOTADMIN_BULK_HARD_DELETE_ABORTED', {
          userId,
          failedPackageId: pkg.id,
          packagesTotal: packages.length,
          filesRemoved,
          filesAlreadyMissing,
          error: messageOf(error),
        });
        res.status(statusOf(error)).json({
          error: messageOf(error),
          partial: filesRemoved > 0 || filesAlreadyMissing > 0,
          failedPackageId: pkg.id,
          filesRemoved,
          filesAlreadyMissing,
        });
        return;
      }
    }
  } else {
    const updated = await prisma.package.updateMany({
      where: { userId, isDeleted: false },
      data: { isDeleted: true, deletedAt: new Date(), deletedBy: actor(req), status: 'DELETED' },
    });
    audit(req, 'BOTADMIN_BULK_SOFT_DELETE', { userId, packagesUpdated: updated.count });
    res.json({ deletedPackages: updated.count, filesRemoved: 0, filesAlreadyMissing: 0, hard: false });
    return;
  }

  audit(req, 'BOTADMIN_BULK_HARD_DELETE', {
    userId,
    packages: packages.length,
    filesRemoved,
    filesAlreadyMissing,
  });
  res.json({
    deletedPackages: packages.length,
    filesRemoved,
    filesAlreadyMissing,
    hard: true,
  });
});
