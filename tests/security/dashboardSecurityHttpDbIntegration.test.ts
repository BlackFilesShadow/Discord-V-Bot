process.env.NODE_ENV = 'test';

const axiosPost = jest.fn();
const axiosGet = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    post: (...args: unknown[]) => axiosPost(...args),
    get: (...args: unknown[]) => axiosGet(...args),
  },
}));

import crypto from 'node:crypto';
import express from 'express';
import session from 'express-session';
import request from 'supertest';
import type { Client } from 'discord.js';
import prisma from '../../src/database/prisma';
import { authRouter } from '../../src/dashboard/routes/auth';
import { apiRouter } from '../../src/dashboard/routes/api';
import { ticketsRouter } from '../../src/dashboard/routes/v2/tickets';
import { requireAuth } from '../../src/dashboard/middleware/auth';
import { idempotency } from '../../src/dashboard/middleware/idempotency';
import { setDashboardClient } from '../../src/dashboard/clientRegistry';
import { describeDb } from '../helpers/dbIntegration';

const TEST_SNOWFLAKE_PREFIX = ['913456789', '01234567'].join('');
const DISCORD_ID = `${TEST_SNOWFLAKE_PREFIX}8`;
const OTHER_OWNER = `${TEST_SNOWFLAKE_PREFIX}9`;
const GUILD_A = `${TEST_SNOWFLAKE_PREFIX}0`;
const GUILD_B = `${TEST_SNOWFLAKE_PREFIX}1`;
const SESSION_TOKEN = 'stage36-http-db-session-token';

function cookieValue(res: { headers: Record<string, string | string[] | undefined> }): string {
  const raw = res.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return String(first ?? '').split(';', 1)[0];
}

function memorySessionApp() {
  const app = express();
  app.use(express.json());
  app.use(session({
    secret: ['stage', 'test'].join('-'),
    resave: false,
    saveUninitialized: false,
  }));
  return app;
}

async function createUserAndSession(token = SESSION_TOKEN) {
  const user = await prisma.user.create({
    data: {
      discordId: DISCORD_ID,
      username: 'stage-security-integration',
    },
  });
  await prisma.session.create({
    data: {
      userId: user.id,
      token,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  return user;
}

async function cleanupSecurityRows(): Promise<void> {
  await prisma.auditLog.deleteMany({ where: { guildId: { in: [GUILD_A, GUILD_B] } } });
  await prisma.ticketTemplate.deleteMany({ where: { guildId: { in: [GUILD_A, GUILD_B] } } });
  await prisma.guildPermissionGrant.deleteMany({ where: { guildId: { in: [GUILD_A, GUILD_B] } } });
  await prisma.user.deleteMany({ where: { discordId: DISCORD_ID } });
}

async function waitForCompletedClaim(hash: string) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const claim = await prisma.idempotencyKey.findUnique({ where: { hash } });
    if (claim?.status === 'DONE') return claim;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return prisma.idempotencyKey.findUnique({ where: { hash } });
}

function ticketTemplate(guildId: string, slot: number, label: string) {
  return {
    guildId,
    slot,
    label,
    welcomeText: 'Willkommen',
    welcomeMessages: ['Willkommen'],
    embedTitle: `${label} Ticket`,
    postChannelId: ['923456789', '01234567', String(slot)].join(''),
    transcriptChannelId: ['933456789', '01234567', String(slot)].join(''),
  };
}

describeDb('Stages 36-38/43 real HTTP + PostgreSQL security chain', () => {
  const claimHashes = new Set<string>();

  beforeEach(async () => {
    jest.clearAllMocks();
    await cleanupSecurityRows();
  });

  afterEach(async () => {
    if (claimHashes.size > 0) {
      await prisma.idempotencyKey.deleteMany({ where: { hash: { in: [...claimHashes] } } });
      claimHashes.clear();
    }
    await cleanupSecurityRows();
  });

  it('rotates the OAuth cookie session and makes revocation authoritative for /auth/status and /api/me', async () => {
    axiosPost.mockResolvedValue({
      data: {
        access_token: 'discord-access-token',
        refresh_token: 'discord-refresh-token',
        expires_in: 3600,
        scope: 'identify guilds email',
        token_type: 'Bearer',
      },
    });
    axiosGet.mockResolvedValue({
      data: {
        id: DISCORD_ID,
        username: 'stage-security-integration',
        discriminator: '0',
        email: 'stage-security@example.invalid',
      },
    });

    const app = memorySessionApp();
    app.get('/seed-oauth', (req, res) => {
      (req.session as unknown as Record<string, unknown>).oauthState = 'fixed-oauth-state';
      (req.session as unknown as Record<string, unknown>).oauthNonce = 'fixed-oauth-nonce';
      (req.session as unknown as Record<string, unknown>).pkceVerifier = 'fixed-pkce-verifier';
      req.session.save(err => (err ? res.status(500).end() : res.status(204).end()));
    });
    app.use('/auth', authRouter);
    app.use('/api', apiRouter);

    const agent = request.agent(app);
    const seeded = await agent.get('/seed-oauth');
    expect(seeded.status).toBe(204);
    const preLoginCookie = cookieValue(seeded);
    expect(preLoginCookie).toContain('connect.sid=');

    const callback = await agent
      .get('/auth/callback')
      .query({ code: 'discord-code', state: 'fixed-oauth-state' });
    expect(callback.status).toBe(302);
    const authenticatedCookie = cookieValue(callback);
    expect(authenticatedCookie).toContain('connect.sid=');
    expect(authenticatedCookie).not.toBe(preLoginCookie);

    const me = await agent.get('/api/me');
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({
      discordId: DISCORD_ID,
      username: 'stage-security-integration',
      role: 'USER',
    });

    const activeStatus = await agent.get('/auth/status');
    expect(activeStatus.status).toBe(200);
    expect(activeStatus.body).toMatchObject({ authenticated: true, role: 'USER' });

    const dbSession = await prisma.session.findFirstOrThrow({
      where: { user: { discordId: DISCORD_ID } },
    });
    await prisma.session.update({
      where: { id: dbSession.id },
      data: { isActive: false },
    });

    const revokedStatus = await agent.get('/auth/status');
    expect(revokedStatus.status).toBe(200);
    expect(revokedStatus.body).toEqual({ authenticated: false });

    const revokedMe = await agent.get('/api/me');
    expect(revokedMe.status).toBe(401);
    expect(await prisma.session.findUnique({ where: { id: dbSession.id } }))
      .toMatchObject({ isActive: false });
  });

  it('keeps a foreign-guild entity ID unreadable and immutable through the production route stack', async () => {
    const user = await createUserAndSession();
    const noMembers = () => ({
      cache: new Map(),
      fetch: jest.fn().mockResolvedValue(null),
    });
    const guildA = { id: GUILD_A, ownerId: DISCORD_ID, members: noMembers() };
    const guildB = { id: GUILD_B, ownerId: OTHER_OWNER, members: noMembers() };
    setDashboardClient({
      guilds: { cache: new Map([[GUILD_A, guildA], [GUILD_B, guildB]]) },
    } as unknown as Client);

    const own = await prisma.ticketTemplate.create({ data: ticketTemplate(GUILD_A, 1, 'Own') });
    const foreign = await prisma.ticketTemplate.create({ data: ticketTemplate(GUILD_B, 2, 'Foreign') });

    const app = memorySessionApp();
    app.post('/seed-session', (req, res) => {
      Object.assign(req.session, {
        userId: user.id,
        discordId: DISCORD_ID,
        role: 'USER',
        sessionToken: SESSION_TOKEN,
      });
      req.session.save(err => (err ? res.status(500).end() : res.status(204).end()));
    });
    app.use('/api/v2', requireAuth, idempotency);
    app.use('/api/v2/guilds/:guildId/tickets', ticketsRouter);

    const agent = request.agent(app);
    expect((await agent.post('/seed-session')).status).toBe(204);

    const list = await agent.get(`/api/v2/guilds/${GUILD_A}/tickets`);
    expect(list.status).toBe(200);
    expect(list.body.templates.map((row: { id: string }) => row.id)).toEqual([own.id]);

    const attack = await agent
      .put(`/api/v2/guilds/${GUILD_A}/tickets/${foreign.id}`)
      .set('X-Idempotency-Key', ['stage37', 'foreign', 'id'].join('-'))
      .send({ label: 'Compromised' });
    expect(attack.status).toBe(404);

    const unchanged = await prisma.ticketTemplate.findUniqueOrThrow({ where: { id: foreign.id } });
    expect(unchanged).toMatchObject({ guildId: GUILD_B, label: 'Foreign' });

    const foreignGuildPath = await agent.get(`/api/v2/guilds/${GUILD_B}/tickets`);
    expect(foreignGuildPath.status).toBe(403);
  });

  it('claims a concurrent mutation atomically in PostgreSQL and writes its side effect once', async () => {
    const user = await createUserAndSession();
    const app = memorySessionApp();
    app.post('/seed-session', (req, res) => {
      Object.assign(req.session, {
        userId: user.id,
        discordId: DISCORD_ID,
        role: 'USER',
        sessionToken: SESSION_TOKEN,
      });
      req.session.save(err => (err ? res.status(500).end() : res.status(204).end()));
    });
    app.post('/mutation', requireAuth, idempotency, async (_req, res) => {
      const row = await prisma.auditLog.create({
        data: {
          guildId: GUILD_A,
          action: 'STAGE38_REAL_DB_SIDE_EFFECT',
          category: 'SECURITY',
        },
      });
      res.status(201).json({ id: row.id });
    });

    const agent = request.agent(app);
    expect((await agent.post('/seed-session')).status).toBe(204);
    const key = 'stage38-real-db-key';
    const body = { value: 'same-request' };
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    const claimHash = crypto.createHash('sha256')
      .update([user.id, 'POST', '/mutation', key, bodyHash].join(':'))
      .digest('hex');
    claimHashes.add(claimHash);
    const [a, b] = await Promise.all([
      agent.post('/mutation').set('X-Idempotency-Key', key).send(body),
      agent.post('/mutation').set('X-Idempotency-Key', key).send(body),
    ]);

    expect([201, 409]).toContain(a.status);
    expect([201, 409]).toContain(b.status);
    expect(a.status === 201 || b.status === 201).toBe(true);
    expect(await prisma.auditLog.count({
      where: { guildId: GUILD_A, action: 'STAGE38_REAL_DB_SIDE_EFFECT' },
    })).toBe(1);

    const claim = await waitForCompletedClaim(claimHash);
    expect(claim?.status).toBe('DONE');
    expect(claim?.responseStatus).toBe(201);
  });
});
