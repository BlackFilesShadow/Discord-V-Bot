import { Router, Request, Response, NextFunction } from 'express';
import prisma from '../../database/prisma';
import { getAnalytics, checkAlerts } from '../../modules/logging/analyticsManager';

/**
 * API-Routes für das Dashboard (Sektion 7):
 * - Übersicht, Steuerung, Statistiken, Logs
 * - Zugriff nur für authentifizierte User
 */

export const apiRouter = Router();

/**
 * Auth-Middleware: Prüft Login und 2FA-Status.
 */
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const userId = (req.session as any)?.userId;
  if (!userId) {
    res.status(401).json({ error: 'Nicht authentifiziert' });
    return;
  }

  if ((req.session as any).requires2FA) {
    res.status(403).json({ error: '2FA-Verifizierung erforderlich' });
    return;
  }

  next();
}

apiRouter.use(requireAuth);

/**
 * Dashboard-Statistiken.
 */
apiRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const analytics = await getAnalytics(days);
    res.json(analytics);
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Statistiken' });
  }
});

/**
 * Alerts & Warnungen.
 */
apiRouter.get('/alerts', async (_req: Request, res: Response) => {
  try {
    const alerts = await checkAlerts();
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Alerts' });
  }
});

/**
 * User-Übersicht.
 */
apiRouter.get('/users', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const perPage = parseInt(req.query.perPage as string) || 20;
    const filter = req.query.filter as string;

    const where: Record<string, unknown> = {};
    if (filter === 'manufacturers') where.isManufacturer = true;
    if (filter === 'banned') where.status = 'BANNED';

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, discordId: true, username: true, role: true, status: true,
          isManufacturer: true, createdAt: true,
          _count: { select: { packages: true, uploads: true, downloads: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    res.json({ users, total, page, totalPages: Math.ceil(total / perPage) });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der User' });
  }
});

/**
 * Paket-Übersicht.
 */
apiRouter.get('/packages', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const perPage = parseInt(req.query.perPage as string) || 20;
    const status = req.query.status as string;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;

    const [packages, total] = await Promise.all([
      prisma.package.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { username: true, discordId: true } },
          _count: { select: { files: true, downloads: true } },
        },
      }),
      prisma.package.count({ where }),
    ]);

    res.json({
      packages: packages.map((p: any) => ({
        ...p,
        totalSize: p.totalSize.toString(),
      })),
      total,
      page,
      totalPages: Math.ceil(total / perPage),
    });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Pakete' });
  }
});

/**
 * Audit-Logs.
 */
apiRouter.get('/audit-logs', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const perPage = parseInt(req.query.perPage as string) || 50;
    const category = req.query.category as string;
    const days = parseInt(req.query.days as string) || 7;

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const where: Record<string, unknown> = { createdAt: { gte: since } };
    if (category) where.category = category;

    const [logs, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        skip: (page - 1) * perPage,
        take: perPage,
        orderBy: { createdAt: 'desc' },
        include: {
          actor: { select: { username: true, discordId: true } },
          target: { select: { username: true, discordId: true } },
        },
      }),
      prisma.auditLog.count({ where }),
    ]);

    res.json({ logs, total, page, totalPages: Math.ceil(total / perPage) });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Logs' });
  }
});

/**
 * Security-Events.
 */
apiRouter.get('/security-events', async (req: Request, res: Response) => {
  try {
    const unresolvedOnly = req.query.unresolved === 'true';
    const severity = req.query.severity as string;

    const where: Record<string, unknown> = {};
    if (unresolvedOnly) where.isResolved = false;
    if (severity) where.severity = severity;

    const events = await prisma.securityEvent.findMany({
      where,
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: { user: { select: { username: true, discordId: true } } },
    });

    res.json({ events });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Security-Events' });
  }
});

/**
 * Giveaways-Übersicht.
 */
apiRouter.get('/giveaways', async (_req: Request, res: Response) => {
  try {
    const giveaways = await prisma.giveaway.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: {
        creator: { select: { username: true, discordId: true } },
        _count: { select: { entries: true } },
      },
    });

    res.json({ giveaways });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Giveaways' });
  }
});

/**
 * Moderation-Fälle.
 */
apiRouter.get('/moderation', async (req: Request, res: Response) => {
  try {
    const activeOnly = req.query.active === 'true';
    const where: Record<string, unknown> = {};
    if (activeOnly) where.isActive = true;

    const cases = await prisma.moderationCase.findMany({
      where,
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: {
        targetUser: { select: { username: true, discordId: true } },
        moderator: { select: { username: true, discordId: true } },
        _count: { select: { appeals: true } },
      },
    });

    res.json({ cases });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Moderationsfälle' });
  }
});

/**
 * Level- & XP-Leaderboard (pro Guild).
 * Query-Param `guildId` ist erforderlich.
 */
apiRouter.get('/leaderboard', async (req: Request, res: Response) => {
  try {
    const guildId = (req.query.guildId as string | undefined)?.trim();
    if (!guildId) {
      res.status(400).json({ error: 'guildId Query-Parameter erforderlich' });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;

    const entries = await prisma.levelData.findMany({
      where: { guildId },
      take: limit,
      orderBy: { xp: 'desc' },
      include: { user: { select: { username: true, discordId: true } } },
    });

    res.json({
      guildId,
      entries: entries.map((e: any) => ({
        ...e,
        xp: e.xp.toString(),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden des Leaderboards' });
  }
});

/**
 * Bot-Konfiguration.
 */
apiRouter.get('/config', async (_req: Request, res: Response) => {
  try {
    const configs = await prisma.botConfig.findMany({
      orderBy: [{ category: 'asc' }, { key: 'asc' }],
    });
    res.json({ configs });
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Konfiguration' });
  }
});
