import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

/**
 * Logging & Analytics Modul (Sektion 11):
 * - Detaillierte Logs aller Aktionen (Join/Leave, Nachrichten, Moderation, Giveaways, Rollen, Votes)
 * - Statistiken und Auswertungen für Admins und Entwickler
 * - Exportfunktionen, Filter, Alerting bei Auffälligkeiten
 * - Zugriff nur für Developer/Admins, DSGVO-konform
 */

/**
 * Erstellt einen Audit-Log-Eintrag in der Datenbank.
 */
export async function createAuditLogEntry(
  action: string,
  category: string,
  actorId?: string,
  targetId?: string,
  details?: Record<string, unknown>,
  channelId?: string,
  guildId?: string,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorId,
        targetId,
        action,
        category: category as any,
        details: details as any,
        channelId,
        guildId,
        isImmutable: true,
      },
    });

    // Auch im File-Logger loggen (revisionssicher)
    logAudit(action, category, {
      actorId, targetId, details, channelId, guildId,
    });
  } catch (error) {
    logger.error('Fehler beim Erstellen des Audit-Logs:', error);
  }
}

/**
 * Erstellt ein Security-Event in der Datenbank.
 */
export async function createSecurityEvent(
  eventType: string,
  severity: string,
  description: string,
  userId?: string,
  ipAddress?: string,
  details?: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.securityEvent.create({
      data: {
        userId,
        eventType: eventType as any,
        severity: severity as any,
        description,
        details: details as any,
        ipAddress,
      },
    });
  } catch (error) {
    logger.error('Fehler beim Erstellen des Security-Events:', error);
  }
}

/**
 * Holt Statistiken für den Developer-Bereich.
 */
export async function getAnalytics(days: number = 30): Promise<{
  userStats: { total: number; new: number; manufacturers: number; banned: number };
  packageStats: { total: number; active: number; quarantined: number; totalSize: number };
  uploadStats: { total: number; valid: number; invalid: number };
  downloadStats: { total: number; byType: Record<string, number> };
  moderationStats: { total: number; active: number; byAction: Record<string, number> };
  securityStats: { total: number; unresolved: number; bySeverity: Record<string, number> };
  activityStats: { logins: number; commands: number; messages: number };
}> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [
    totalUsers, newUsers, manufacturers, banned,
    totalPackages, activePackages, quarantinedPackages,
    totalUploads, validUploads, invalidUploads,
    totalDownloads,
    totalCases, activeCases,
    totalSecEvents, unresolvedSecEvents,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: since } } }),
    prisma.user.count({ where: { isManufacturer: true } }),
    prisma.user.count({ where: { status: 'BANNED' } }),
    prisma.package.count(),
    prisma.package.count({ where: { status: 'ACTIVE' } }),
    prisma.package.count({ where: { status: 'QUARANTINED' } }),
    prisma.upload.count(),
    prisma.upload.count({ where: { isValid: true } }),
    prisma.upload.count({ where: { validationStatus: 'INVALID' } }),
    prisma.download.count({ where: { createdAt: { gte: since } } }),
    prisma.moderationCase.count(),
    prisma.moderationCase.count({ where: { isActive: true } }),
    prisma.securityEvent.count({ where: { createdAt: { gte: since } } }),
    prisma.securityEvent.count({ where: { isResolved: false } }),
  ]);

  // Downloads nach Typ
  const downloadsByType = await prisma.download.groupBy({
    by: ['downloadType'],
    where: { createdAt: { gte: since } },
    _count: { id: true },
  });
  const byDownloadType: Record<string, number> = {};
  for (const d of downloadsByType) {
    byDownloadType[d.downloadType] = d._count.id;
  }

  // Moderationsaktionen nach Typ
  const casesByAction = await prisma.moderationCase.groupBy({
    by: ['action'],
    _count: { id: true },
  });
  const byAction: Record<string, number> = {};
  for (const c of casesByAction) {
    byAction[c.action] = c._count.id;
  }

  // Security nach Schweregrad
  const secBySeverity = await prisma.securityEvent.groupBy({
    by: ['severity'],
    where: { createdAt: { gte: since } },
    _count: { id: true },
  });
  const bySeverity: Record<string, number> = {};
  for (const s of secBySeverity) {
    bySeverity[s.severity] = s._count.id;
  }

  // Aktivitätsstatistiken aus Audit-Logs
  const [logins, commands, messages] = await Promise.all([
    prisma.auditLog.count({ where: { category: 'AUTH', createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { category: 'SYSTEM', action: { contains: 'COMMAND' }, createdAt: { gte: since } } }),
    prisma.auditLog.count({ where: { category: 'SYSTEM', action: { contains: 'MESSAGE' }, createdAt: { gte: since } } }),
  ]);

  // Paketgröße aggregieren
  const totalSizeResult = await prisma.package.aggregate({
    _sum: { totalSize: true },
  });

  return {
    userStats: { total: totalUsers, new: newUsers, manufacturers, banned },
    packageStats: { total: totalPackages, active: activePackages, quarantined: quarantinedPackages, totalSize: Number(totalSizeResult._sum.totalSize || 0) },
    uploadStats: { total: totalUploads, valid: validUploads, invalid: invalidUploads },
    downloadStats: { total: totalDownloads, byType: byDownloadType },
    moderationStats: { total: totalCases, active: activeCases, byAction },
    securityStats: { total: totalSecEvents, unresolved: unresolvedSecEvents, bySeverity },
    activityStats: { logins, commands, messages },
  };
}

/**
 * Prüft auf Auffälligkeiten und gibt Alerts zurück.
 */
export async function checkAlerts(): Promise<string[]> {
  const alerts: string[] = [];

  // Hohe Anzahl ungelöster Security-Events
  const unresolvedCritical = await prisma.securityEvent.count({
    where: { isResolved: false, severity: 'CRITICAL' },
  });
  if (unresolvedCritical > 0) {
    alerts.push(`🔴 ${unresolvedCritical} ungelöste kritische Security-Events`);
  }

  // Viele Loginversuche in kurzer Zeit
  const recentLoginFailures = await prisma.securityEvent.count({
    where: {
      eventType: 'LOGIN_FAILURE',
      createdAt: { gte: new Date(Date.now() - 60 * 60 * 1000) },
    },
  });
  if (recentLoginFailures > 10) {
    alerts.push(`🟠 ${recentLoginFailures} Login-Fehlversuche in der letzten Stunde`);
  }

  // Pakete in Quarantäne
  const quarantined = await prisma.package.count({ where: { status: 'QUARANTINED' } });
  if (quarantined > 0) {
    alerts.push(`🟡 ${quarantined} Pakete in Quarantäne`);
  }

  // Ausstehende GDPR-Löschanträge
  const pendingDeletions = await prisma.dataDeletionRequest.count({
    where: { status: 'PENDING' },
  });
  if (pendingDeletions > 0) {
    alerts.push(`🟡 ${pendingDeletions} ausstehende DSGVO-Löschanträge`);
  }

  // Ausstehende Appeals
  const pendingAppeals = await prisma.appeal.count({
    where: { status: 'PENDING' },
  });
  if (pendingAppeals > 5) {
    alerts.push(`🟡 ${pendingAppeals} ausstehende Moderations-Appeals`);
  }

  return alerts;
}

/**
 * DSGVO-konforme Datenlöschung.
 */
export async function processDataDeletionRequest(requestId: string): Promise<boolean> {
  const request = await prisma.dataDeletionRequest.findUnique({
    where: { id: requestId },
  });

  if (!request || request.status !== 'PENDING') return false;

  await prisma.dataDeletionRequest.update({
    where: { id: requestId },
    data: { status: 'IN_PROGRESS' },
  });

  try {
    const user = await prisma.user.findUnique({
      where: { discordId: request.discordId },
    });

    if (!user) {
      await prisma.dataDeletionRequest.update({
        where: { id: requestId },
        data: { status: 'FAILED', details: { error: 'User not found' } as any },
      });
      return false;
    }

    switch (request.requestType) {
      case 'FULL_DELETION':
        // Alle Daten löschen
        await prisma.user.delete({ where: { id: user.id } });
        break;

      case 'PARTIAL_DELETION':
        // Nur persönliche Daten anonymisieren
        await prisma.user.update({
          where: { id: user.id },
          data: {
            username: `deleted_${user.id.substring(0, 8)}`,
            email: null,
            discriminator: '',
          },
        });
        break;

      case 'ANONYMIZATION':
        await prisma.user.update({
          where: { id: user.id },
          data: {
            username: `anon_${user.id.substring(0, 8)}`,
            email: null,
            discriminator: '',
          },
        });
        break;

      case 'DATA_EXPORT':
        // Export wird über admin-export Command abgewickelt
        break;
    }

    await prisma.dataDeletionRequest.update({
      where: { id: requestId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    logAudit('GDPR_DELETION_COMPLETED', 'GDPR', {
      requestId, userId: user.id, type: request.requestType,
    });

    return true;
  } catch (error) {
    await prisma.dataDeletionRequest.update({
      where: { id: requestId },
      data: { status: 'FAILED', details: { error: String(error) } as any },
    });
    logger.error('GDPR-Löschung fehlgeschlagen:', error);
    return false;
  }
}
