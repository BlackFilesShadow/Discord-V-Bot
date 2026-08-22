import express from 'express';
import request from 'supertest';
import type { Guild } from 'discord.js';

const getDashboardClient = jest.fn();
const resolveDelegatedPermissionContext = jest.fn();
const logAudit = jest.fn();

jest.mock('../../src/dashboard/clientRegistry', () => ({
  getDashboardClient: (...args: unknown[]) => getDashboardClient(...args),
}));

jest.mock('../../src/modules/permissions/access', () => ({
  resolveDelegatedPermissionContext: (...args: unknown[]) => resolveDelegatedPermissionContext(...args),
}));

jest.mock('../../src/utils/logger', () => ({
  logAudit: (...args: unknown[]) => logAudit(...args),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {},
}));

import {
  requireGuildOwner,
  requireGuildPermission,
  requireGuildAccess,
} from '../../src/dashboard/middleware/auth';

const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';
const OWNER = '437718598876268545';
const MEMBER = '537718598876268546';
const STRANGER = '637718598876268547';

function guildStub(opts: {
  id: string;
  ownerId: string;
}): Guild {
  return {
    id: opts.id,
    ownerId: opts.ownerId,
    members: { cache: new Map(), fetch: jest.fn() },
  } as unknown as Guild;
}

function appFor(
  mw: express.RequestHandler,
  auth?: { userId: string; discordId: string; role?: string },
  priorScope?: {
    guildId: string;
    nitradoConnId: string | null;
    actorDiscordId: string;
  },
) {
  const app = express();
  app.use((req, _res, next) => {
    if (auth) {
      req.auth = {
        userId: auth.userId,
        discordId: auth.discordId as never,
        role: auth.role ?? 'USER',
      };
    }
    if (priorScope) {
      req.guildScope = {
        guildId: priorScope.guildId as never,
        nitradoConnId: priorScope.nitradoConnId as never,
        actorDiscordId: priorScope.actorDiscordId as never,
        isOwner: false,
        permissions: new Set(),
      };
    }
    next();
  });
  app.get('/guilds/:guildId/probe', mw, (req, res) => {
    res.json({
      ok: true,
      scope: req.guildScope
        ? {
            guildId: req.guildScope.guildId,
            isOwner: req.guildScope.isOwner,
            nitradoConnId: req.guildScope.nitradoConnId,
            perms: Array.from(req.guildScope.permissions),
          }
        : null,
    });
  });
  return app;
}

describe('Stage 37 requireGuildPermission / owner / access IDOR runtime gate', () => {
  beforeEach(() => {
    getDashboardClient.mockReset();
    resolveDelegatedPermissionContext.mockReset();
    logAudit.mockReset();
  });

  it('DENY unauthenticated without calling Discord cache', async () => {
    const res = await request(appFor(requireGuildPermission('whitelist.view')))
      .get(`/guilds/${GUILD_A}/probe`);
    expect(res.status).toBe(401);
    expect(getDashboardClient).not.toHaveBeenCalled();
  });

  it('DENY invalid guildId snowflake with 400 before cache lookup', async () => {
    const res = await request(appFor(
      requireGuildPermission('whitelist.view'),
      { userId: 'u1', discordId: MEMBER },
    )).get('/guilds/not-a-snowflake/probe');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/guildId/i);
    expect(getDashboardClient).not.toHaveBeenCalled();
  });

  it('DENY foreign guild when bot not present (no existence oracle)', async () => {
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: () => undefined } } });
    const res = await request(appFor(
      requireGuildPermission('whitelist.view'),
      { userId: 'u1', discordId: MEMBER },
    )).get(`/guilds/${GUILD_B}/probe`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('BOT_NOT_PRESENT');
    expect(resolveDelegatedPermissionContext).not.toHaveBeenCalled();
  });

  it('DENY non-member even if stale grant path would otherwise apply', async () => {
    const g = guildStub({ id: GUILD_A, ownerId: OWNER });
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: (id: string) => (id === GUILD_A ? g : undefined) } } });
    resolveDelegatedPermissionContext.mockResolvedValue({ member: null, permissions: new Set(['whitelist.view']) });

    const res = await request(appFor(
      requireGuildPermission('whitelist.view'),
      { userId: 'u1', discordId: STRANGER },
    )).get(`/guilds/${GUILD_A}/probe`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Kein Zugriff/i);
    expect(logAudit).toHaveBeenCalledWith(
      'GUILD_MEMBERSHIP_REQUIRED',
      'SECURITY',
      expect.objectContaining({ guildId: GUILD_A, discordId: STRANGER }),
    );
  });

  it('DENY member missing required permission scope', async () => {
    const g = guildStub({ id: GUILD_A, ownerId: OWNER });
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: () => g } } });
    resolveDelegatedPermissionContext.mockResolvedValue({
      member: { id: MEMBER } as never,
      permissions: new Set(['whitelist.view']),
    });

    const res = await request(appFor(
      requireGuildPermission('economy.manage'),
      { userId: 'u1', discordId: MEMBER },
    )).get(`/guilds/${GUILD_A}/probe`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('economy.manage');
    expect(logAudit).toHaveBeenCalledWith(
      'GUILD_PERM_DENIED',
      'SECURITY',
      expect.objectContaining({ perm: 'economy.manage', guildId: GUILD_A }),
    );
  });

  it('ALLOW owner full access without delegated grant lookup side-effects on deny path', async () => {
    const g = guildStub({ id: GUILD_A, ownerId: OWNER });
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: () => g } } });

    const res = await request(appFor(
      requireGuildPermission('economy.manage'),
      { userId: 'u-owner', discordId: OWNER },
    )).get(`/guilds/${GUILD_A}/probe`);

    expect(res.status).toBe(200);
    expect(res.body.scope.isOwner).toBe(true);
    expect(res.body.scope.guildId).toBe(GUILD_A);
    expect(resolveDelegatedPermissionContext).not.toHaveBeenCalled();
  });

  it('ALLOW member with exact grant and binds guildScope.guildId from path only', async () => {
    const g = guildStub({ id: GUILD_A, ownerId: OWNER });
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: () => g } } });
    resolveDelegatedPermissionContext.mockResolvedValue({
      member: { id: MEMBER } as never,
      permissions: new Set(['whitelist.manage']),
    });

    const res = await request(appFor(
      requireGuildPermission('whitelist.manage'),
      { userId: 'u1', discordId: MEMBER },
    )).get(`/guilds/${GUILD_A}/probe`);

    expect(res.status).toBe(200);
    expect(res.body.scope).toEqual({
      guildId: GUILD_A,
      isOwner: false,
      nitradoConnId: null,
      perms: ['whitelist.manage'],
    });
  });

  it('does not leak prior guildScope nitradoConnId across different guild path (cross-guild scope reset)', async () => {
    const g = guildStub({ id: GUILD_B, ownerId: OWNER });
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: () => g } } });
    resolveDelegatedPermissionContext.mockResolvedValue({
      member: { id: MEMBER } as never,
      permissions: new Set(['economy.view']),
    });

    const res = await request(appFor(
      requireGuildPermission('economy.view'),
      { userId: 'u1', discordId: MEMBER },
      {
        guildId: GUILD_A,
        nitradoConnId: 'c123456789012345678901234',
        actorDiscordId: MEMBER,
      },
    )).get(`/guilds/${GUILD_B}/probe`);

    expect(res.status).toBe(200);
    expect(res.body.scope.guildId).toBe(GUILD_B);
    expect(res.body.scope.nitradoConnId).toBeNull();
  });

  it('preserves nitradoConnId only for same guild + same actor revalidation', async () => {
    const g = guildStub({ id: GUILD_A, ownerId: OWNER });
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: () => g } } });
    resolveDelegatedPermissionContext.mockResolvedValue({
      member: { id: MEMBER } as never,
      permissions: new Set(['economy.view']),
    });

    const res = await request(appFor(
      requireGuildPermission('economy.view'),
      { userId: 'u1', discordId: MEMBER },
      {
        guildId: GUILD_A,
        nitradoConnId: 'c123456789012345678901234',
        actorDiscordId: MEMBER,
      },
    )).get(`/guilds/${GUILD_A}/probe`);

    expect(res.status).toBe(200);
    expect(res.body.scope.nitradoConnId).toBe('c123456789012345678901234');
  });

  it('requireGuildOwner DENY non-owner with 403', async () => {
    const g = guildStub({ id: GUILD_A, ownerId: OWNER });
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: () => g } } });

    const res = await request(appFor(
      requireGuildOwner,
      { userId: 'u1', discordId: MEMBER },
    )).get(`/guilds/${GUILD_A}/probe`);

    expect(res.status).toBe(403);
    expect(logAudit).toHaveBeenCalledWith(
      'GUILD_OWNER_DENIED',
      'SECURITY',
      expect.objectContaining({ guildId: GUILD_A, discordId: MEMBER }),
    );
  });

  it('requireGuildAccess DENY when non-owner has zero grants despite membership', async () => {
    const g = guildStub({ id: GUILD_A, ownerId: OWNER });
    getDashboardClient.mockReturnValue({ guilds: { cache: { get: () => g } } });
    resolveDelegatedPermissionContext.mockResolvedValue({
      member: { id: MEMBER } as never,
      permissions: new Set(),
    });

    const res = await request(appFor(
      requireGuildAccess,
      { userId: 'u1', discordId: MEMBER },
    )).get(`/guilds/${GUILD_A}/probe`);

    expect(res.status).toBe(403);
  });
});
