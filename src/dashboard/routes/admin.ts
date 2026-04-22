import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../database/prisma';
import { createAuditLogEntry, createSecurityEvent, processDataDeletionRequest } from '../../modules/logging/analyticsManager';

/**
 * Admin-Routes für das Dashboard (Sektion 7/10):
 * - Benutzerverwaltung, Paketverwaltung, Sicherheitseinstellungen
 * - Zugriff nur für ADMIN/DEVELOPER-Rolle mit 2FA
 */

export const adminRouter = Router();

function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  const session = req.session as any;
  if (!session?.userId) {
    res.status(401).json({ error: 'Nicht authentifiziert' });
    return;
  }
  if (session.requires2FA) {
    res.status(403).json({ error: '2FA-Verifizierung erforderlich' });
    return;
  }
  if (!['ADMIN', 'DEVELOPER'].includes(session.role)) {
    res.status(403).json({ error: 'Keine Admin-Berechtigung' });
    return;
  }
  next();
}

adminRouter.use(requireAdmin);

// ===== Benutzerverwaltung =====

adminRouter.patch('/users/:id/role', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { role } = req.body;
    const validRoles = ['USER', 'MANUFACTURER', 'MODERATOR', 'ADMIN', 'DEVELOPER'];
    if (!validRoles.includes(role)) {
      res.status(400).json({ error: `Ungültige Rolle. Erlaubt: ${validRoles.join(', ')}` });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, username: true, role: true },
    });

    await createAuditLogEntry(
      'USER_ROLE_CHANGE', 'USER_MANAGEMENT',
      (req.session as any).userId, id,
      { newRole: role },
    );

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Ändern der Rolle' });
  }
});

adminRouter.patch('/users/:id/status', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { status, reason } = req.body;
    const validStatuses = ['ACTIVE', 'BANNED', 'SUSPENDED'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: `Ungültiger Status. Erlaubt: ${validStatuses.join(', ')}` });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data: { status },
      select: { id: true, username: true, status: true },
    });

    await createAuditLogEntry(
      `USER_STATUS_${status}`, 'USER_MANAGEMENT',
      (req.session as any).userId, id,
      { newStatus: status, reason: reason || '' },
    );

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Ändern des Status' });
  }
});

adminRouter.patch('/users/:id/upload-rights', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { enabled, reason } = req.body;

    // WICHTIG: isManufacturer und role MUESSEN konsistent gehalten werden,
    // sonst entstehen halbgare Hersteller-Zustaende, die /register manufacturer
    // blockieren oder Permission-Checks falsch passieren lassen.
    // Aktuelle Rolle laden, damit wir Admin/Dev-Rollen nicht ueberschreiben.
    const current = await prisma.user.findUnique({
      where: { id },
      select: { role: true },
    });
    const isPrivileged = current && ['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(current.role);

    const data: { isManufacturer: boolean; role?: 'USER' | 'MANUFACTURER'; manufacturerApprovedAt?: Date | null } = {
      isManufacturer: !!enabled,
    };
    if (!isPrivileged) {
      data.role = enabled ? 'MANUFACTURER' : 'USER';
      data.manufacturerApprovedAt = enabled ? new Date() : null;
    }

    const user = await prisma.user.update({
      where: { id },
      data: data as any,
      select: { id: true, username: true, isManufacturer: true, role: true },
    });

    await createAuditLogEntry(
      enabled ? 'UPLOAD_ENABLED' : 'UPLOAD_DISABLED', 'USER_MANAGEMENT',
      (req.session as any).userId, id,
      { enabled, reason: reason || '' },
    );

    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Ändern der Upload-Rechte' });
  }
});

// ===== Paketverwaltung =====

adminRouter.patch('/packages/:id/status', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { status, reason } = req.body;
    const validStatuses = ['ACTIVE', 'QUARANTINED', 'DELETED'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: `Ungültiger Status. Erlaubt: ${validStatuses.join(', ')}` });
      return;
    }

    const pkg = await prisma.package.update({
      where: { id },
      data: {
        status,
        ...(status === 'DELETED' ? { isDeleted: true, deletedAt: new Date(), deletedBy: (req.session as any).userId } : {}),
      },
      select: { id: true, name: true, status: true },
    });

    await createAuditLogEntry(
      `PACKAGE_${status}`, 'PACKAGE_MANAGEMENT',
      (req.session as any).userId, undefined,
      { packageId: id, packageName: pkg.name, newStatus: status, reason: reason || '' },
    );

    res.json({ package: pkg });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Ändern des Paket-Status' });
  }
});

// ===== Bot-Konfiguration =====

adminRouter.put('/config/:key', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as string;
    const { value, category, description } = req.body;

    if (value === undefined) {
      res.status(400).json({ error: 'Wert ist erforderlich' });
      return;
    }

    // Input-Validierung: Wert muss ein String sein
    const safeValue = typeof value === 'string' ? value : JSON.stringify(value);
    const safeCategory = typeof category === 'string' ? category.substring(0, 100) : 'general';
    const safeDescription = typeof description === 'string' ? description.substring(0, 500) : '';

    const config = await prisma.botConfig.upsert({
      where: { key },
      create: { key, value: safeValue, category: safeCategory, description: safeDescription },
      update: { value: safeValue, ...(category ? { category: safeCategory } : {}), ...(description ? { description: safeDescription } : {}) },
    });

    await createAuditLogEntry(
      'CONFIG_CHANGE', 'SYSTEM',
      (req.session as any).userId, undefined,
      { key, value, category },
    );

    res.json({ config });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Setzen der Konfiguration' });
  }
});

adminRouter.delete('/config/:key', async (req: Request, res: Response) => {
  try {
    const key = req.params.key as string;
    await prisma.botConfig.delete({ where: { key } });

    await createAuditLogEntry(
      'CONFIG_DELETE', 'SYSTEM',
      (req.session as any).userId, undefined,
      { key },
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Löschen der Konfiguration' });
  }
});

// ===== Sicherheit =====

adminRouter.post('/security/ip-block', async (req: Request, res: Response) => {
  try {
    const { ipAddress, reason, expiresAt } = req.body;
    if (!ipAddress) {
      res.status(400).json({ error: 'ipAddress ist erforderlich' });
      return;
    }

    const entry = await prisma.ipList.create({
      data: {
        ipAddress,
        listType: 'BLACKLIST',
        reason: reason || 'Manuell gesperrt',
        addedBy: (req.session as any).userId,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    await createSecurityEvent(
      'IP_BLACKLISTED', 'MEDIUM',
      `IP ${ipAddress} gesperrt: ${reason || 'Kein Grund'}`,
      (req.session as any).userId,
    );

    res.json({ entry });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Sperren der IP' });
  }
});

adminRouter.delete('/security/ip-block/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await prisma.ipList.delete({ where: { id } });

    await createAuditLogEntry(
      'IP_UNBLOCK', 'SECURITY',
      (req.session as any).userId, undefined,
      { ipListId: id },
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Entsperren der IP' });
  }
});

adminRouter.patch('/security/events/:id/resolve', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    const event = await prisma.securityEvent.update({
      where: { id },
      data: {
        isResolved: true,
        resolvedAt: new Date(),
        resolvedBy: (req.session as any).userId,
      },
    });

    res.json({ event });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Auflösen des Events' });
  }
});

// ===== Appeals =====

adminRouter.patch('/appeals/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const { status, reviewNote } = req.body;
    if (!['APPROVED', 'DENIED'].includes(status)) {
      res.status(400).json({ error: 'Status muss APPROVED oder DENIED sein' });
      return;
    }

    const appeal = await prisma.appeal.update({
      where: { id },
      data: {
        status,
        reviewNote: reviewNote || '',
        reviewedBy: (req.session as any).userId,
        reviewedAt: new Date(),
      },
      include: {
        case: true,
      },
    });

    if (status === 'APPROVED' && appeal.case) {
      await prisma.moderationCase.update({
        where: { id: appeal.case.id },
        data: { isActive: false },
      });
    }

    await createAuditLogEntry(
      `APPEAL_${status}`, 'MODERATION',
      (req.session as any).userId, appeal.userId,
      { appealId: id, caseId: appeal.caseId, reviewNote },
    );

    res.json({ appeal });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Bearbeiten des Appeals' });
  }
});

// ===== GDPR =====

adminRouter.post('/gdpr/deletion', async (req: Request, res: Response) => {
  try {
    const { requestId } = req.body;
    if (!requestId) {
      res.status(400).json({ error: 'requestId ist erforderlich' });
      return;
    }

    const result = await processDataDeletionRequest(requestId);
    res.json({ success: result });
  } catch (error) {
    res.status(500).json({ error: 'Fehler bei der Datenlöschung' });
  }
});

// ===== Feeds =====

adminRouter.get('/feeds', async (_req: Request, res: Response) => {
  try {
    const feeds = await prisma.feed.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        _count: { select: { subscriptions: true } },
      },
    });
    res.json({ feeds });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Feeds' });
  }
});

adminRouter.delete('/feeds/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await prisma.feed.delete({ where: { id } });

    await createAuditLogEntry(
      'FEED_DELETE', 'SYSTEM',
      (req.session as any).userId, undefined,
      { feedId: id },
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Löschen des Feeds' });
  }
});

// ===== Sessions =====

adminRouter.get('/sessions', async (_req: Request, res: Response) => {
  try {
    const sessions = await prisma.session.findMany({
      where: { expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { username: true, discordId: true, role: true } } },
    });
    res.json({ sessions, count: sessions.length });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Sessions' });
  }
});

adminRouter.delete('/sessions/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    await prisma.session.delete({ where: { id } });

    await createAuditLogEntry(
      'SESSION_FORCE_LOGOUT', 'SECURITY',
      (req.session as any).userId, undefined,
      { sessionId: id },
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Beenden der Session' });
  }
});
