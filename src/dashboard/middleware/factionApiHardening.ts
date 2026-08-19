import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { PermissionFlagsBits } from 'discord.js';
import prisma from '../../database/prisma';
import { asGuildId } from '../../types/scope';
import { validateBotChannelAccess } from '../../utils/discordChannel';
import { tryGetDashboardClient } from '../clientRegistry';

const SNOWFLAKE_RE = /^\d{17,20}$/;
const VALID_MEMBER_ROLES = new Set(['LEADER', 'TREASURER', 'MEMBER', 'PENDING']);
const MUTATION_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

interface ValidationFailure {
  status: 400 | 403 | 503;
  error: string;
}

function normalizedPath(req: Request): string {
  const value = req.path || '/';
  return value.startsWith('/') ? value : `/${value}`;
}

function nonEmptySnowflake(value: unknown): string | null {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value) ? value : null;
}

function optionalSnowflake(
  body: Record<string, unknown>,
  key: string,
): { present: false } | { present: true; value: string | null } | { present: true; error: string } {
  if (!Object.prototype.hasOwnProperty.call(body, key)) return { present: false };
  const raw = body[key];
  if (raw === null || raw === '') return { present: true, value: null };
  const value = nonEmptySnowflake(raw);
  if (!value) return { present: true, error: `${key} ungueltig (Discord-Snowflake erwartet).` };
  return { present: true, value };
}

async function validateDiscordReferences(req: Request): Promise<ValidationFailure | null> {
  const scope = req.guildScope;
  if (!scope) return { status: 403, error: 'Guild-Scope fehlt.' };

  const method = req.method.toUpperCase();
  const routePath = normalizedPath(req);
  const body = ((req.body ?? {}) as Record<string, unknown>);
  const memberIds = new Set<string>();
  let roleId: string | null | undefined;
  let channelId: string | null | undefined;

  const isFactionCreate = method === 'POST' && routePath === '/';
  const isFactionPatch = method === 'PATCH' && /^\/[^/]+$/.test(routePath);
  if (isFactionCreate || isFactionPatch) {
    for (const key of ['leaderDiscordId', 'deputyDiscordId', 'treasurerDiscordId'] as const) {
      const parsed = optionalSnowflake(body, key);
      if (parsed.present && 'error' in parsed) return { status: 400, error: parsed.error };
      if (parsed.present && 'value' in parsed && parsed.value) memberIds.add(parsed.value);
    }

    const role = optionalSnowflake(body, 'roleId');
    if (role.present && 'error' in role) return { status: 400, error: role.error };
    if (role.present && 'value' in role) roleId = role.value;

    const channel = optionalSnowflake(body, 'embedChannelId');
    if (channel.present && 'error' in channel) return { status: 400, error: channel.error };
    if (channel.present && 'value' in channel) channelId = channel.value;
  }

  if (method === 'PUT' && routePath === '/system-config') {
    const channel = optionalSnowflake(body, 'factionChannelId');
    if (channel.present && 'error' in channel) return { status: 400, error: channel.error };
    if (channel.present && 'value' in channel) channelId = channel.value;
  }

  if (method === 'POST' && /^\/[^/]+\/members$/.test(routePath)) {
    const explicitRole = body.role;
    if (explicitRole !== undefined && (typeof explicitRole !== 'string' || !VALID_MEMBER_ROLES.has(explicitRole))) {
      return { status: 400, error: 'role ungueltig.' };
    }
    const memberId = nonEmptySnowflake(body.userDiscordId);
    if (!memberId) return { status: 400, error: 'userDiscordId ungueltig.' };
    memberIds.add(memberId);
  }

  if (memberIds.size === 0 && !roleId && !channelId) return null;

  const client = tryGetDashboardClient();
  if (!client) return { status: 503, error: 'Bot nicht bereit; Discord-Referenzen koennen nicht sicher validiert werden.' };

  const guild = await client.guilds.fetch(asGuildId(scope.guildId)).catch(() => null);
  if (!guild) return { status: 503, error: 'Guild ist fuer den Bot derzeit nicht erreichbar.' };

  for (const memberId of memberIds) {
    const member = await guild.members.fetch(memberId).catch(() => null);
    if (!member) return { status: 400, error: `Discord-Mitglied ${memberId} gehoert nicht zur Guild.` };
  }

  if (roleId) {
    const role = guild.roles.cache.get(roleId) ?? await guild.roles.fetch(roleId).catch(() => null);
    if (!role || role.id === guild.id || role.managed) {
      return { status: 400, error: 'roleId ist keine zuweisbare Rolle dieser Guild.' };
    }
    const me = guild.members.me;
    if (!me) return { status: 503, error: 'Bot-Mitgliedschaft der Guild ist nicht aufloesbar.' };
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return { status: 400, error: 'Bot besitzt keine Berechtigung zum Verwalten von Rollen.' };
    }
    if (role.position >= me.roles.highest.position) {
      return { status: 400, error: 'roleId liegt auf oder ueber der hoechsten Bot-Rolle.' };
    }
  }

  if (channelId) {
    const validation = await validateBotChannelAccess(client, scope.guildId, channelId, [
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.SendMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
    ]);
    if (!validation.ok) return { status: 400, error: validation.reason };
  }

  return null;
}

/**
 * Baut FactionSystemConfig race-sicher auf und validiert Discord-Referenzen
 * erst NACH authorisiertem Guild-Scope. Die eigentliche Route prueft danach
 * weiterhin ihr exaktes factions.view/factions.manage-Recht.
 */
export async function factionApiPreflight(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const scope = req.guildScope;
    if (!scope) {
      res.status(403).json({ error: 'Guild-Scope fehlt.' });
      return;
    }

    const validation = await validateDiscordReferences(req);
    if (validation) {
      res.status(validation.status).json({ error: validation.error });
      return;
    }

    const routePath = normalizedPath(req);
    if (routePath === '/system-config' && (req.method === 'GET' || req.method === 'PUT')) {
      await prisma.factionSystemConfig.upsert({
        where: { guildId: scope.guildId },
        create: { guildId: scope.guildId },
        update: {},
      });
    }

    next();
  } catch (error) {
    next(error);
  }
}

/** Zwei int32-Schluessel ohne Guild-ID-Klartext in PostgreSQL/Logs. */
export function factionMutationLockKeys(guildId: string): [number, number] {
  const digest = crypto.createHash('sha256').update(`factions-api:v1:${guildId}`).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

function shouldSerializeMutation(req: Request): boolean {
  if (!MUTATION_METHODS.has(req.method.toUpperCase())) return false;
  const routePath = normalizedPath(req);
  // Multipart kann bis 25 MB gross sein. Den DB-Connection-Slot nicht waehrend
  // des Upload-Streams halten; DB-Races dieser Pfade werden vom Error-Boundary
  // fail-closed in 404/409 uebersetzt.
  if (req.method === 'POST' && (routePath === '/upload' || /^\/[^/]+\/upload$/.test(routePath))) return false;
  return true;
}

function waitForResponse(req: Request, res: Response, next: NextFunction): Promise<void> {
  return new Promise((resolve, reject) => {
    if (res.writableEnded || res.destroyed) {
      resolve();
      return;
    }

    let settled = false;
    const cleanup = () => {
      res.off('finish', done);
      res.off('close', done);
      req.off('aborted', done);
    };
    const done = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    res.once('finish', done);
    res.once('close', done);
    req.once('aborted', done);
    try {
      next();
    } catch (error) {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    }
  });
}

/**
 * Cross-process Race-Barriere fuer schnelle Faction-API-Mutationen. `try_lock`
 * vermeidet, dass konkurrierende Requests wartend den Prisma-Pool fuellen:
 * der Gewinner haelt genau eine Transaktion bis zum HTTP-Abschluss, Verlierer
 * bekommen sofort einen retrybaren 409.
 */
export async function factionMutationSerialization(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!shouldSerializeMutation(req)) {
    next();
    return;
  }

  const scope = req.guildScope;
  if (!scope) {
    res.status(403).json({ error: 'Guild-Scope fehlt.' });
    return;
  }

  const [key1, key2] = factionMutationLockKeys(scope.guildId);
  try {
    await prisma.$transaction(async tx => {
      const rows = await tx.$queryRawUnsafe<Array<{ locked: boolean }>>(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS locked',
        key1,
        key2,
      );
      if (!rows[0]?.locked) {
        res.status(409).json({ error: 'Fraktionsdaten werden gerade geaendert. Bitte Anfrage erneut versuchen.' });
        return;
      }
      await waitForResponse(req, res, next);
    }, { maxWait: 5_000, timeout: 30_000 });
  } catch (error) {
    if (!res.headersSent && !res.writableEnded) next(error);
    else if (!res.destroyed) res.destroy();
  }
}

/**
 * Erwartbare Prisma-Konflikte aus parallelen Faction-Aktionen werden als
 * stabile HTTP-Semantik behandelt statt als generischer 500er.
 */
export function factionApiErrorBoundary(error: unknown, _req: Request, res: Response, next: NextFunction): void {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';

  if (code === 'P2025') {
    res.status(404).json({ error: 'Fraktionsobjekt existiert nicht mehr.' });
    return;
  }
  if (code === 'P2002') {
    res.status(409).json({ error: 'Fraktionsdaten kollidieren mit einem bereits vorhandenen Datensatz.' });
    return;
  }
  if (code === 'P2003') {
    res.status(409).json({ error: 'Fraktionsdaten wurden parallel geaendert; referenzierter Datensatz existiert nicht mehr.' });
    return;
  }
  next(error);
}
