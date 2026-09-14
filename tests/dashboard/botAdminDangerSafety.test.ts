process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';
process.env.DEV_PASSWORD = 'purge-step-up-secret';

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireBotAdmin: (req: { auth?: unknown }, _res: unknown, next: () => void) => {
    req.auth = { userId: 'admin-user-1', discordId: '123456789012345678', role: 'ADMIN' }; // gitleaks:allow (synthetic test fixture, not a real Discord ID)
    next();
  },
}));

const mockBotConfigStore = new Map<string, { key: string; value: unknown }>();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    package: { findMany: jest.fn() },
    twoFactorAuth: { findUnique: jest.fn().mockResolvedValue(null) },
    botConfig: {
      findUnique: async ({ where: { key } }: { where: { key: string } }) =>
        mockBotConfigStore.get(key) ?? null,
      upsert: async ({ where: { key }, create, update }: {
        where: { key: string };
        create: { value: unknown };
        update: { value: unknown };
      }) => {
        const value = mockBotConfigStore.has(key) ? update.value : create.value;
        mockBotConfigStore.set(key, { key, value });
      },
      deleteMany: async ({ where }: { where?: { key?: string } }) => {
        if (where?.key) mockBotConfigStore.delete(where.key);
      },
    },
  },
}));

const mockHardDelete = jest.fn();
jest.mock('../../src/modules/packages/hardDeletePackage', () => {
  const actual = jest.requireActual('../../src/modules/packages/hardDeletePackage');
  return { ...actual, hardDeletePackage: mockHardDelete };
});

const mockLogAudit = jest.fn();
const mockLogAuditDb = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  logAudit: mockLogAudit,
  logAuditDb: mockLogAuditDb,
}));

import express from 'express';
import request from 'supertest';
import prisma from '../../src/database/prisma';
import { HardDeletePackageError } from '../../src/modules/packages/hardDeletePackage';
import { botAdminDangerSafetyRouter } from '../../src/dashboard/routes/v2/botAdminDangerSafety';

const findManyMock = prisma.package.findMany as jest.Mock;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/bot-admin', botAdminDangerSafetyRouter);
  return instance;
}

const STEP_UP = { reason: 'Geplante Bereinigung geloeschter Pakete', reAuth: 'purge-step-up-secret' };

describe('BotAdmin danger purge safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBotConfigStore.clear();
    (prisma.twoFactorAuth.findUnique as jest.Mock).mockResolvedValue(null);
    findManyMock.mockResolvedValue([{ id: 'pkg-a' }, { id: 'pkg-b' }]);
    mockHardDelete.mockResolvedValue({ filesRemoved: 1, filesAlreadyMissing: 0 });
  });

  it('verweigert Requests ohne gueltigen Step-Up (Reason/Re-Auth)', async () => {
    const res = await request(app()).post('/bot-admin/danger/purge-deleted-packages').send({ confirm: 'DELETE' });
    expect(res.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(mockHardDelete).not.toHaveBeenCalled();
  });

  it('verlangt weiterhin die explizite DELETE-Bestaetigung', async () => {
    const res = await request(app()).post('/bot-admin/danger/purge-deleted-packages').send({ ...STEP_UP });
    expect(res.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(mockHardDelete).not.toHaveBeenCalled();
  });

  it('purgt jedes Soft-Delete-Paket ausschliesslich ueber den kanonischen Filesystem-Service', async () => {
    const res = await request(app())
      .post('/bot-admin/danger/purge-deleted-packages')
      .send({ confirm: 'DELETE', ...STEP_UP });

    expect(res.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { isDeleted: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(mockHardDelete).toHaveBeenNthCalledWith(1, 'pkg-a', { requireSoftDeleted: true });
    expect(mockHardDelete).toHaveBeenNthCalledWith(2, 'pkg-b', { requireSoftDeleted: true });
    expect(res.body).toMatchObject({ purged: 2, totalCandidates: 2, filesRemoved: 2, filesAlreadyMissing: 0 });
    expect(mockLogAudit).toHaveBeenCalledWith('BOTADMIN_DANGER_PURGE_PACKAGES', 'ADMIN', expect.any(Object));
    expect(mockLogAuditDb).toHaveBeenCalled();
  });

  it('ueberspringt ein parallel wiederhergestelltes Paket statt es physisch zu loeschen', async () => {
    mockHardDelete
      .mockRejectedValueOnce(new HardDeletePackageError('Hard-Delete blockiert: Paket ist nicht mehr als geloescht markiert.', 409))
      .mockResolvedValueOnce({ filesRemoved: 2, filesAlreadyMissing: 1 });

    const res = await request(app())
      .post('/bot-admin/danger/purge-deleted-packages')
      .send({ confirm: 'DELETE', ...STEP_UP });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ purged: 1, totalCandidates: 2, filesRemoved: 2, filesAlreadyMissing: 1 });
  });

  it('bricht bei echtem Delete-Fehler mit explizitem Partial-State ab', async () => {
    mockHardDelete
      .mockResolvedValueOnce({ filesRemoved: 1, filesAlreadyMissing: 0 })
      .mockRejectedValueOnce(new HardDeletePackageError('Datei konnte nicht entfernt werden.', 500));

    const res = await request(app())
      .post('/bot-admin/danger/purge-deleted-packages')
      .send({ confirm: 'DELETE', ...STEP_UP });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      partial: true,
      failedPackageId: 'pkg-b',
      purged: 1,
      total: 2,
      filesRemoved: 1,
    });
    expect(mockLogAudit).toHaveBeenCalledWith('BOTADMIN_DANGER_PURGE_ABORTED', 'ADMIN', expect.objectContaining({ failedPackageId: 'pkg-b' }));
    expect(mockLogAuditDb).toHaveBeenCalled();
  });
});
