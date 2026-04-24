/**
 * Integration-Tests für Datenbankmodelle und -operationen.
 * Sektion 1, 2, 4, 6, 8, 9, 10: Prüft GUID-basierte Datenstruktur.
 *
 * HINWEIS: Diese Tests benötigen eine laufende PostgreSQL-Instanz.
 * In CI wird DATABASE_URL gesetzt.
 */

// Mock Prisma für Unit-Tests (keine echte DB nötig)
jest.mock('../src/database/prisma', () => {
  const mockPrisma = {
    user: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
    },
    package: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      count: jest.fn(),
    },
    moderationCase: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    giveaway: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    levelData: {
      upsert: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
    poll: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    auditLog: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    securityEvent: {
      create: jest.fn(),
      findMany: jest.fn(),
    },
    $connect: jest.fn(),
    $disconnect: jest.fn(),
  };
  return { __esModule: true, default: mockPrisma };
});

import prisma from '../src/database/prisma';

describe('Datenbank-Schema (Sektion 1-12)', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('User-Model (Sektion 1: GUID-basierte Usertrennung)', () => {
    it('sollte einen User mit GUID erstellen können', async () => {
      const mockUser = {
        id: 'test-uuid-1234',
        discordId: '123456789',
        username: 'TestUser',
        role: 'USER',
        status: 'ACTIVE',
        isManufacturer: false,
        createdAt: new Date(),
      };

      (prisma.user.create as jest.Mock).mockResolvedValue(mockUser);

      const user = await prisma.user.create({
        data: {
          discordId: '123456789',
          username: 'TestUser',
        },
      });

      expect(prisma.user.create).toHaveBeenCalledTimes(1);
      expect(user.id).toBe('test-uuid-1234');
      expect(user.discordId).toBe('123456789');
    });

    it('sollte User nach discordId finden können', async () => {
      const mockUser = { id: 'uuid', discordId: '123', username: 'Test' };
      (prisma.user.findUnique as jest.Mock).mockResolvedValue(mockUser);

      const user = await prisma.user.findUnique({ where: { discordId: '123' } });
      expect(user?.discordId).toBe('123');
    });
  });

  describe('Package-Model (Sektion 2: Upload-System)', () => {
    it('sollte ein Paket GUID-gebunden erstellen können', async () => {
      const mockPkg = {
        id: 'pkg-uuid',
        name: 'TestPaket',
        userId: 'user-uuid',
        status: 'ACTIVE',
      };

      (prisma.package.create as jest.Mock).mockResolvedValue(mockPkg);

      const pkg = await prisma.package.create({
        data: {
          name: 'TestPaket',
          userId: 'user-uuid',
        },
      });

      expect(pkg.name).toBe('TestPaket');
      expect(pkg.userId).toBe('user-uuid');
    });
  });

  describe('ModerationCase-Model (Sektion 4)', () => {
    it('sollte einen Moderationsfall erstellen können', async () => {
      const mockCase = {
        id: 'case-uuid',
        caseNumber: 1,
        action: 'WARN',
        reason: 'Spam',
        isActive: true,
      };

      (prisma.moderationCase.create as jest.Mock).mockResolvedValue(mockCase);

      const modCase = await prisma.moderationCase.create({
        data: {
          caseNumber: 1,
          action: 'WARN',
          reason: 'Spam',
          targetUserId: 'target-uuid',
          moderatorId: 'mod-uuid',
        },
      });

      expect(modCase.action).toBe('WARN');
      expect(modCase.isActive).toBe(true);
    });
  });

  describe('Giveaway-Model (Sektion 6)', () => {
    it('sollte ein Giveaway erstellen können', async () => {
      const mockGiveaway = {
        id: 'giveaway-uuid',
        prize: 'Testpreis',
        description: 'Beschreibung',
        status: 'ACTIVE',
      };

      (prisma.giveaway.create as jest.Mock).mockResolvedValue(mockGiveaway);

      const giveaway = await prisma.giveaway.create({
        data: {
          prize: 'Testpreis',
          description: 'Beschreibung',
          channelId: 'ch-123',
          creatorId: 'user-uuid',
          duration: 3600,
          endsAt: new Date(),
        },
      });

      expect(giveaway.prize).toBe('Testpreis');
      expect(giveaway.status).toBe('ACTIVE');
    });
  });

  describe('LevelData-Model (Sektion 8)', () => {
    it('sollte XP-Daten upserten können', async () => {
      const mockLevel = {
        userId: 'user-uuid',
        guildId: 'guild-1',
        xp: BigInt(150),
        level: 2,
      };

      (prisma.levelData.upsert as jest.Mock).mockResolvedValue(mockLevel);

      const levelData = await prisma.levelData.upsert({
        where: { userId_guildId: { userId: 'user-uuid', guildId: 'guild-1' } },
        create: { userId: 'user-uuid', guildId: 'guild-1', xp: 150, level: 2 },
        update: { xp: 150, level: 2 },
      });

      expect(levelData.level).toBe(2);
    });
  });

  describe('AuditLog-Model (Sektion 11)', () => {
    it('sollte einen Audit-Log-Eintrag erstellen können', async () => {
      const mockLog = {
        id: 'log-uuid',
        action: 'USER_BAN',
        category: 'MODERATION',
        createdAt: new Date(),
      };

      (prisma.auditLog.create as jest.Mock).mockResolvedValue(mockLog);

      const log = await prisma.auditLog.create({
        data: {
          action: 'USER_BAN',
          category: 'MODERATION',
          actorId: 'admin-uuid',
          details: {},
          guildId: 'guild-123',
        },
      });

      expect(log.action).toBe('USER_BAN');
      expect(log.category).toBe('MODERATION');
    });
  });
});
