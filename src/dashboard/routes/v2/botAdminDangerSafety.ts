import { Router, type Request } from 'express';
import { requireBotAdmin } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAudit, logAuditDb } from '../../../utils/logger';
import { hardDeletePackage, HardDeletePackageError } from '../../../modules/packages/hardDeletePackage';

export const botAdminDangerSafetyRouter = Router();
botAdminDangerSafetyRouter.use(requireBotAdmin);

function actor(req: Request): string {
  return String(req.auth?.discordId ?? req.auth?.userId ?? 'dashboard');
}

function audit(req: Request, action: string, details: Record<string, unknown>): void {
  logAudit(action, 'ADMIN', { ...details, by: actor(req) });
  logAuditDb(action, 'ADMIN', {
    actorUserId: req.auth?.userId ?? null,
    details,
    ip: req.ip ?? null,
    userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
  });
}

/**
 * Sicherheits-Override fuer die Legacy-Gefahrenzone.
 *
 * Der alte Pfad loeschte nur Package-DB-Zeilen per deleteMany und konnte
 * physische Upload-Dateien verwaisen lassen. Dieser Router wird vor dem
 * Legacy-BotAdmin-Router gemountet und fuehrt jedes Paket ueber denselben
 * fail-closed Hard-Delete-Service wie die Einzel-Loeschung.
 */
botAdminDangerSafetyRouter.post('/danger/purge-deleted-packages', async (req, res) => {
  if (req.body?.confirm !== 'DELETE') {
    res.status(400).json({ error: 'Bestätigung "DELETE" erforderlich.' });
    return;
  }

  const packages = await prisma.package.findMany({
    where: { isDeleted: true },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });

  let purged = 0;
  let filesRemoved = 0;
  let filesAlreadyMissing = 0;

  for (const pkg of packages) {
    try {
      const result = await hardDeletePackage(pkg.id, { requireSoftDeleted: true });
      purged += 1;
      filesRemoved += result.filesRemoved;
      filesAlreadyMissing += result.filesAlreadyMissing;
    } catch (error) {
      // Ein parallel wiederhergestelltes Paket ist kein Purge-Fehler: Es gehoert
      // nicht mehr zur Zielmenge und wird bewusst uebersprungen.
      if (error instanceof HardDeletePackageError && error.status === 409 && /nicht mehr als geloescht/i.test(error.message)) {
        continue;
      }

      const status = error instanceof HardDeletePackageError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      audit(req, 'BOTADMIN_DANGER_PURGE_ABORTED', {
        failedPackageId: pkg.id,
        purged,
        total: packages.length,
        filesRemoved,
        filesAlreadyMissing,
        error: message,
      });
      res.status(status).json({
        error: error instanceof HardDeletePackageError
          ? error.message
          : 'Purge abgebrochen: Paket konnte nicht sicher physisch entfernt werden.',
        partial: purged > 0,
        failedPackageId: pkg.id,
        purged,
        total: packages.length,
        filesRemoved,
        filesAlreadyMissing,
      });
      return;
    }
  }

  audit(req, 'BOTADMIN_DANGER_PURGE_PACKAGES', {
    count: purged,
    totalCandidates: packages.length,
    filesRemoved,
    filesAlreadyMissing,
  });
  res.json({ purged, totalCandidates: packages.length, filesRemoved, filesAlreadyMissing });
});
