import type { NextFunction, Request, Response } from 'express';
import { tryGetDashboardClient } from '../clientRegistry';

const SNOWFLAKE = /^\d{17,20}$/;

/**
 * Stellt fuer die aus `/dev-admin add` migrierte HTTP-Funktion dieselbe
 * Referenzintegritaet wie die fruehere Discord-User-Option her. Eine formal
 * gueltige Snowflake alleine darf keinen globalen ADMIN-Datensatz erzeugen.
 */
export async function guardDevAdminTarget(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.method.toUpperCase() !== 'POST' || req.path !== '/admins') {
    next();
    return;
  }

  const discordId = String(req.body?.discordId ?? '').trim();
  if (!SNOWFLAKE.test(discordId)) {
    res.status(400).json({ error: 'Ungültige Discord-ID.' });
    return;
  }

  const client = tryGetDashboardClient();
  if (!client) {
    res.status(503).json({ error: 'Discord-Client nicht verfügbar.' });
    return;
  }

  const discordUser = await client.users.fetch(discordId).catch(() => null);
  if (!discordUser) {
    res.status(404).json({ error: 'Discord-User nicht gefunden. Admin-Rolle wurde nicht angelegt.' });
    return;
  }

  next();
}
