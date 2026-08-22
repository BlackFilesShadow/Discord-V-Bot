import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

if (process.env.E2E_REAL_DB !== '1') {
  throw new Error('Refusing to start the real dashboard E2E harness without E2E_REAL_DB=1.');
}
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for the real dashboard E2E harness.');
}

process.env.NODE_ENV = 'test';
process.env.DASHBOARD_PORT = process.env.DASHBOARD_PORT ?? '4173';
process.env.DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:4173';
process.env.OAUTH2_REDIRECT_URI = process.env.OAUTH2_REDIRECT_URI
  ?? `${process.env.DASHBOARD_URL}/auth/callback`;
process.env.SESSION_SECRET = process.env.SESSION_SECRET ?? ['stage', '2735', 'session'].join('-');
process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? 'a'.repeat(64);
process.env.DISCORD_TOKEN = process.env.DISCORD_TOKEN ?? ['stage', '2735', 'bot'].join('-');
process.env.DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? ['913456789', '01234567', '7'].join('');
process.env.DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET ?? ['stage', '2735', 'oauth'].join('-');
process.env.BOT_OWNER_ID = process.env.BOT_OWNER_ID ?? ['913456789', '01234567', '8'].join('');
process.env.TRUST_PROXY = 'false';
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'warn';

const runtimeRoot = path.join(os.tmpdir(), `vbot-dashboard-e2e-${process.pid}`);
process.env.UPLOAD_DIR = path.join(runtimeRoot, 'uploads');
process.env.PRIVATE_UPLOAD_DIR = path.join(runtimeRoot, 'private');
process.env.DEV_UPLOAD_DIR = path.join(runtimeRoot, 'private', 'dev-logs');
process.env.EXPORT_DIR = path.join(runtimeRoot, 'private', 'exports');
process.env.LOG_DIR = path.join(runtimeRoot, 'logs');

const DISCORD_ID = process.env.BOT_OWNER_ID;
const GUILD_ID = ['923456789', '01234567', '0'].join('');
const OTHER_GUILD_ID = ['923456789', '01234567', '1'].join('');
const AUDIT_PREFIX = 'settings.patch.e2e.';
const requireRuntime = createRequire(__filename);

async function main(): Promise<void> {
  const axiosModule = await import('axios');
  const axiosClient = axiosModule.default as unknown as {
    get: (url: string, config?: unknown) => Promise<unknown>;
    post: (url: string, body?: unknown, config?: unknown) => Promise<unknown>;
  };

  axiosClient.post = async (url: string) => {
    if (!url.endsWith('/oauth2/token')) throw new Error(`Unexpected E2E axios POST: ${url}`);
    return {
      status: 200,
      data: {
        access_token: ['stage', '2735', 'access'].join('-'),
        refresh_token: ['stage', '2735', 'refresh'].join('-'),
        expires_in: 3600,
        scope: 'identify guilds email',
        token_type: 'Bearer',
      },
    };
  };

  axiosClient.get = async (url: string) => {
    if (url.endsWith('/users/@me/guilds')) {
      return {
        status: 200,
        data: [{
          id: GUILD_ID,
          name: 'Stage 27–35 Real DB Guild',
          icon: null,
          owner: true,
          permissions: '8',
        }],
      };
    }
    if (url.endsWith('/users/@me')) {
      return {
        status: 200,
        data: {
          id: DISCORD_ID,
          username: 'stage-2735-real-db',
          discriminator: '0',
          email: 'stage-2735@example.invalid',
        },
      };
    }
    throw new Error(`Unexpected E2E axios GET: ${url}`);
  };

  // ts-node/register erweitert den CommonJS-Resolver um `.ts`. Ein nativer
  // dynamic import bleibt unter module=Node16 dagegen bei Node ESM und kann
  // extensionlose TypeScript-Pfade auf Linux nicht aufloesen.
  const { Collection } = requireRuntime('discord.js') as typeof import('discord.js');
  const { default: prisma } = requireRuntime('../src/database/prisma') as typeof import('../src/database/prisma');
  const { startDashboard } = requireRuntime('../src/dashboard/server') as typeof import('../src/dashboard/server');

  const cleanup = async (): Promise<void> => {
    await prisma.auditLog.deleteMany({ where: { guildId: { in: [GUILD_ID, OTHER_GUILD_ID] } } });
    await prisma.nitradoConnection.deleteMany({ where: { guildId: { in: [GUILD_ID, OTHER_GUILD_ID] } } });
    await prisma.dashboardGuildLink.deleteMany({ where: { guildId: { in: [GUILD_ID, OTHER_GUILD_ID] } } });
    await prisma.devSession.deleteMany({ where: { userDiscordId: DISCORD_ID } });
    const users = await prisma.user.findMany({ where: { discordId: DISCORD_ID }, select: { id: true } });
    const userIds = users.map(user => user.id);
    if (userIds.length > 0) {
      await prisma.oAuthToken.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
  };

  await cleanup();
  const user = await prisma.user.create({
    data: {
      discordId: DISCORD_ID,
      username: 'stage-2735-real-db',
      role: 'DEVELOPER',
    },
  });
  await prisma.devSession.create({
    data: {
      userDiscordId: DISCORD_ID,
      // Kein guildIdRestrict: die echte Global-Scope-Guard der DEV-Auditroute
      // muss diesen Seed als globale Session akzeptieren.
      scope: { logs: true, snapshot: true },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await prisma.dashboardGuildLink.create({
    data: {
      guildId: GUILD_ID,
      ownerDiscordId: DISCORD_ID,
      alias5: 'E2E27',
    },
  });
  const connection = await prisma.nitradoConnection.create({
    data: {
      guildId: GUILD_ID,
      slot: 1,
      alias: 'Chernarus Real DB',
      alias5: 'E2S35',
      encryptedToken: ['not', 'used', 'by', 'this', 'test'].join('-'),
      nitradoServerId: '2735001',
      serviceId: '2735002',
      status: 'ACTIVE',
      addedByDiscordId: DISCORD_ID,
    },
  });
  await prisma.serverSettings.create({
    data: {
      guildId: GUILD_ID,
      nitradoConnId: connection.id,
      whitelistActive: true,
      economyActive: false,
    },
  });
  await prisma.auditLog.createMany({
    data: Array.from({ length: 55 }, (_, index) => ({
      actorId: user.id,
      action: `${AUDIT_PREFIX}${String(index).padStart(2, '0')}`,
      category: 'SERVER_SETTINGS' as const,
      guildId: GUILD_ID,
      details: { source: 'real-http-db-playwright', index },
      createdAt: new Date(Date.now() - index * 60_000),
    })),
  });

  const noMembers = () => ({
    cache: new Collection(),
    fetch: async () => null,
  });
  const guild = {
    id: GUILD_ID,
    name: 'Stage 27–35 Real DB Guild',
    ownerId: DISCORD_ID,
    memberCount: 42,
    iconURL: () => null,
    members: noMembers(),
    channels: { cache: new Collection() },
    roles: { cache: new Collection() },
  };
  const client = {
    guilds: { cache: new Collection([[GUILD_ID, guild]]) },
    commands: new Collection(),
  };

  const runtime = await startDashboard(client as never);
  let stopping = false;
  const stop = async (exitCode: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    try {
      await runtime.stop();
      await cleanup();
    } finally {
      await prisma.$disconnect();
      process.exit(exitCode);
    }
  };

  process.once('SIGINT', () => { void stop(0); });
  process.once('SIGTERM', () => { void stop(0); });
  process.once('uncaughtException', error => {
    console.error(error);
    void stop(1);
  });
  process.once('unhandledRejection', error => {
    console.error(error);
    void stop(1);
  });

  console.log(`Real dashboard E2E server ready on ${process.env.DASHBOARD_URL}`);
}

void main().catch(error => {
  console.error(error);
  process.exit(1);
});
