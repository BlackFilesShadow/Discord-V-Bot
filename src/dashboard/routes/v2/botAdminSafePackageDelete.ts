import { Router } from 'express';
import { requireBotAdmin } from '../../middleware/auth';
import prisma from '../../../database/prisma';
import { logAudit, logAuditDb, logger } from '../../../utils/logger';
import { hardDeletePackage, HardDeletePackageError } from '../../../modules/packages/hardDeletePackage';

/**
 * Sicherheits-Override fuer den bestehenden Bot-Admin-Paketpfad.
 *
 * Die alte Dashboard-Route `DELETE /packages/:id?hard=true` loeschte nur den
 * Prisma-Datensatz und konnte dadurch physische Upload-Dateien verwaisen lassen.
 * Dieser Router wird VOR `botAdminRouter` gemountet und uebernimmt ausschliesslich
 * den Hard-Delete-Fall. Soft-Delete faellt mit `next()` weiterhin auf den
 * bestehenden, wiederherstellbaren Pfad zurueck.
 */
export const botAdminSafePackageDeleteRouter = Router();
botAdminSafePackageDeleteRouter.use(requireBotAdmin);

botAdminSafePackageDeleteRouter.delete('/packages/:id', async (req, res, next) => {
  if (req.query.hard !== 'true') {
    next();
    return;
  }

  const packageId = String(req.params.id ?? '');
  const pkg = await prisma.package.findUnique({
    where: { id: packageId },
    select: { id: true, name: true, isDeleted: true },
  });
  if (!pkg) {
    res.status(404).json({ error: 'Paket nicht gefunden.' });
    return;
  }

  // Der bestehende Bot-Admin-UI-Flow bietet Hard-Delete erst nach Soft-Delete
  // und fordert dort explizit die Eingabe DELETE. Direkte HTTP-Aufrufe duerfen
  // diese zweistufige Schutzlogik nicht umgehen.
  if (!pkg.isDeleted) {
    res.status(409).json({ error: 'Paket muss vor dem endgültigen Löschen zuerst als Soft-Delete markiert sein.' });
    return;
  }

  try {
    const result = await hardDeletePackage(packageId);
    const details = {
      packageId,
      packageName: pkg.name,
      ...result,
      by: req.auth?.discordId ?? req.auth?.userId ?? 'dashboard',
    };
    logAudit('BOTADMIN_PACKAGE_HARD_DELETE', 'ADMIN', details);
    logAuditDb('BOTADMIN_PACKAGE_HARD_DELETE', 'ADMIN', {
      actorUserId: req.auth?.userId ?? null,
      details,
      ip: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    });
    res.json({ deleted: true, hard: true, ...result });
  } catch (error) {
    const status = error instanceof HardDeletePackageError ? error.status : 500;
    logger.error('BotAdmin Hard-Delete fehlgeschlagen', {
      packageId,
      status,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(status).json({
      error: error instanceof HardDeletePackageError
        ? error.message
        : 'Hard-Delete fehlgeschlagen. Paket wurde nicht aus der Datenbank entfernt.',
    });
  }
});
