process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * P2-Regression (#11): grantEventXp muss die XP-Konfiguration GUILD-SCOPED
 * laden (xpConfig.id == guildId), nicht die erste aktive Config einer
 * beliebigen fremden Guild via findFirst({ isActive: true }).
 * Leave-1G: vor jeder Event-XP-Mutation muss zusaetzlich der exakt
 * Guild+Discord-gescoppte Leave-Cleanup-Barrier passieren.
 */

const leaveGuard = jest.fn();
const prismaMock = {
  user: {
    findUnique: jest.fn().mockResolvedValue({ discordId: 'discord-1' }),
  },
  levelData: {
    upsert: jest.fn().mockResolvedValue({ xp: BigInt(100), level: 0 }),
    update: jest.fn().mockResolvedValue({}),
  },
  xpRecord: { create: jest.fn().mockResolvedValue({}) },
  xpConfig: {
    findUnique: jest.fn().mockResolvedValue({ id: 'guild-A', maxLevel: 20, isActive: true }),
    findFirst: jest.fn().mockResolvedValue({ id: 'guild-FOREIGN', maxLevel: 999, isActive: true }),
  },
};

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/modules/moderation/leaveCleanupGuard', () => ({
  assertNoOpenLeaveCleanupRequest: leaveGuard,
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAudit: jest.fn(),
  logAuditDb: jest.fn(),
}));

import { grantEventXp } from '../../src/modules/xp/xpManager';

const GUILD = 'guild-A';

beforeEach(() => {
  jest.clearAllMocks();
  leaveGuard.mockResolvedValue(undefined);
  prismaMock.user.findUnique.mockResolvedValue({ discordId: 'discord-1' });
  prismaMock.levelData.upsert.mockResolvedValue({ xp: BigInt(100), level: 0 });
  prismaMock.xpConfig.findUnique.mockResolvedValue({ id: GUILD, maxLevel: 20, isActive: true });
});

describe('grantEventXp — guild-scoped XpConfig (P2 #11)', () => {
  it('resolves the canonical Discord id and fences exact guild+discord before the first XP mutation', async () => {
    await grantEventXp('user-1', GUILD, 50, 'GIVEAWAY');

    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { discordId: true },
    });
    expect(leaveGuard).toHaveBeenCalledWith(GUILD, 'discord-1');
    expect(leaveGuard.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.levelData.upsert.mock.invocationCallOrder[0]);
  });

  it('blocks all Event-XP writes when the leave barrier is open or failed', async () => {
    leaveGuard.mockRejectedValue(new Error('Leave-Cleanup noch offen'));

    await expect(grantEventXp('user-1', GUILD, 50, 'GIVEAWAY'))
      .rejects.toThrow(/Leave-Cleanup/);

    expect(prismaMock.levelData.upsert).not.toHaveBeenCalled();
    expect(prismaMock.xpRecord.create).not.toHaveBeenCalled();
    expect(prismaMock.levelData.update).not.toHaveBeenCalled();
  });

  it('fails closed when the internal User cannot resolve to a Discord id', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    await expect(grantEventXp('user-1', GUILD, 50, 'GIVEAWAY'))
      .rejects.toThrow(/User-Stammsatz\/Discord-ID/);

    expect(leaveGuard).not.toHaveBeenCalled();
    expect(prismaMock.levelData.upsert).not.toHaveBeenCalled();
  });

  it('laedt XpConfig via findUnique({ id: guildId }), nicht findFirst', async () => {
    await grantEventXp('user-1', GUILD, 50, 'GIVEAWAY');
    expect(prismaMock.xpConfig.findUnique).toHaveBeenCalledWith({ where: { id: GUILD } });
    expect(prismaMock.xpConfig.findFirst).not.toHaveBeenCalled();
  });

  it('nutzt maxLevel der eigenen Guild als Cap', async () => {
    // Sehr viel XP -> Level wuerde ohne Cap hoch; eigener maxLevel=5 begrenzt.
    prismaMock.levelData.upsert.mockResolvedValue({ xp: BigInt(10_000_000), level: 0 });
    prismaMock.xpConfig.findUnique.mockResolvedValue({ id: GUILD, maxLevel: 5, isActive: true });
    const r = await grantEventXp('user-1', GUILD, 100, 'POLL');
    expect(r.leveledUp).toBe(true);
    expect(r.newLevel).toBe(5);
    expect(prismaMock.levelData.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { level: 5 } }),
    );
  });
});
