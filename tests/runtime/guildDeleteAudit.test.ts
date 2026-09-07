import fs from 'node:fs';
import path from 'node:path';
import { Events } from 'discord.js';
import prisma from '../../src/database/prisma';
import { logger, logAudit } from '../../src/utils/logger';
import guildDeleteEvent from '../../src/events/guildDelete';

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    guildProfile: { findUnique: jest.fn() },
    auditLog: { create: jest.fn() },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
  },
  logAudit: jest.fn(),
}));

const findGuildProfile = prisma.guildProfile.findUnique as jest.Mock;
const createAudit = prisma.auditLog.create as jest.Mock;
const auditFile = logAudit as jest.Mock;
const warn = logger.warn as jest.Mock;
const error = logger.error as jest.Mock;

function fakeGuild() {
  return {
    id: '1480401485727797289',
    name: 'DeadLand: Jenseits des Schweigens PvE|PvP',
    ownerId: 'owner-123',
    memberCount: 42,
  };
}

describe('Discord guildDelete audit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findGuildProfile.mockResolvedValue({
      name: 'DeadLand: Jenseits des Schweigens PvE|PvP',
      ownerId: 'owner-123',
      ownerName: 'OwnerName',
      memberCount: 42,
      lastSyncedAt: new Date('2026-09-06T14:21:56.444Z'),
    });
    createAudit.mockResolvedValue({ id: 'audit-1' });
  });

  it('ist das echte Discord GuildDelete-Event', () => {
    expect(guildDeleteEvent.name).toBe(Events.GuildDelete);
  });

  it('persistiert Guild-ID, Namen, letzten bekannten Stand und unbekannten Discord-Grund immutable', async () => {
    await guildDeleteEvent.execute(fakeGuild());

    expect(findGuildProfile).toHaveBeenCalledWith({
      where: { guildId: '1480401485727797289' },
      select: {
        name: true,
        ownerId: true,
        ownerName: true,
        memberCount: true,
        lastSyncedAt: true,
      },
    });

    expect(auditFile).toHaveBeenCalledWith(
      'DISCORD_GUILD_LEFT',
      'SYSTEM',
      expect.objectContaining({
        guildId: '1480401485727797289',
        gatewayEvent: Events.GuildDelete,
        guildName: 'DeadLand: Jenseits des Schweigens PvE|PvP',
        ownerId: 'owner-123',
        memberCount: 42,
        reason: 'UNKNOWN_NOT_PROVIDED_BY_DISCORD',
        lastKnownProfile: {
          name: 'DeadLand: Jenseits des Schweigens PvE|PvP',
          ownerId: 'owner-123',
          ownerName: 'OwnerName',
          memberCount: 42,
          lastSyncedAt: '2026-09-06T14:21:56.444Z',
        },
      }),
    );

    expect(createAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DISCORD_GUILD_LEFT',
        category: 'SYSTEM',
        guildId: '1480401485727797289',
        isImmutable: true,
        details: expect.objectContaining({
          gatewayEvent: Events.GuildDelete,
          guildName: 'DeadLand: Jenseits des Schweigens PvE|PvP',
          reason: 'UNKNOWN_NOT_PROVIDED_BY_DISCORD',
        }),
      }),
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('schreibt auch ohne lesbaren GuildProfile-Snapshot weiter und erfindet keinen Grund', async () => {
    findGuildProfile.mockRejectedValueOnce(new Error('db read unavailable'));

    await expect(guildDeleteEvent.execute(fakeGuild())).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('letzter GuildProfile-Stand'),
      expect.any(Error),
    );
    expect(createAudit).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'DISCORD_GUILD_LEFT',
        guildId: '1480401485727797289',
        details: expect.objectContaining({
          guildName: 'DeadLand: Jenseits des Schweigens PvE|PvP',
          ownerId: 'owner-123',
          memberCount: 42,
          lastKnownProfile: null,
          reason: 'UNKNOWN_NOT_PROVIDED_BY_DISCORD',
        }),
      }),
    });
  });

  it('haelt DB-Auditfehler sichtbar, ohne den Discord-Eventpfad zu sprengen', async () => {
    createAudit.mockRejectedValueOnce(new Error('db write unavailable'));

    await expect(guildDeleteEvent.execute(fakeGuild())).resolves.toBeUndefined();

    expect(auditFile).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Guild-Leave-Audit konnte'),
      expect.any(Error),
    );
  });
});

describe('GuildDelete production wiring', () => {
  it('registriert den Handler ueber den zentralen Safe-Event-Registrar und nicht als zweite Direktregistrierung', () => {
    const indexSource = fs.readFileSync(path.join(process.cwd(), 'src/index.ts'), 'utf8');
    expect(indexSource).toContain("import guildDeleteEvent from './events/guildDelete';");
    expect(indexSource).toMatch(/const events: BotEvent\[\] = \[[\s\S]*guildDeleteEvent,[\s\S]*\];/);
    expect(indexSource).not.toContain("client.on('guildDelete'");
  });

  it('bewahrt GuildProfile als letzte bekannte Evidenz und fuehrt keinen destruktiven Guild-Cleanup aus', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'src/events/guildDelete.ts'), 'utf8');
    expect(source).toContain('prisma.guildProfile.findUnique');
    expect(source).not.toMatch(/guildProfile\.(delete|deleteMany|update|updateMany)/);
    expect(source).not.toMatch(/prisma\.[A-Za-z0-9_]+\.(delete|deleteMany)\(/);
  });
});
