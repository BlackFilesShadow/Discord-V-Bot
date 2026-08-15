process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('../../src/dashboard/middleware/auth', () => ({
  requireBotAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    package: { findMany: jest.fn() },
  },
}));

const hardDeleteMock = jest.fn();
class MockHardDeletePackageError extends Error {
  constructor(message: string, public readonly status = 500) {
    super(message);
    this.name = 'HardDeletePackageError';
  }
}

jest.mock('../../src/modules/packages/hardDeletePackage', () => ({
  hardDeletePackage: hardDeleteMock,
  HardDeletePackageError: MockHardDeletePackageError,
}));

const logAuditMock = jest.fn();
const logAuditDbMock = jest.fn();
jest.mock('../../src/utils/logger', () => ({
  logAudit: logAuditMock,
  logAuditDb: logAuditDbMock,
}));

import express from 'express';
import request from 'supertest';
import prisma from '../../src/database/prisma';
import { botAdminDangerSafetyRouter } from '../../src/dashboard/routes/v2/botAdminDangerSafety';

const findManyMock = prisma.package.findMany as jest.Mock;

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/bot-admin', botAdminDangerSafetyRouter);
  return instance;
}

describe('BotAdmin danger purge safety', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findManyMock.mockResolvedValue([{ id: 'pkg-a' }, { id: 'pkg-b' }]);
    hardDeleteMock.mockResolvedValue({ filesRemoved: 1, filesAlreadyMissing: 0 });
  });

  it('verlangt weiterhin die explizite DELETE-Bestaetigung', async () => {
    const res = await request(app()).post('/bot-admin/danger/purge-deleted-packages').send({});
    expect(res.status).toBe(400);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(hardDeleteMock).not.toHaveBeenCalled();
  });

  it('purgt jedes Soft-Delete-Paket ausschliesslich ueber den kanonischen Filesystem-Service', async () => {
    const res = await request(app())
      .post('/bot-admin/danger/purge-deleted-packages')
      .send({ confirm: 'DELETE' });

    expect(res.status).toBe(200);
    expect(findManyMock).toHaveBeenCalledWith({
      where: { isDeleted: true },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    expect(hardDeleteMock).toHaveBeenNthCalledWith(1, 'pkg-a', { requireSoftDeleted: true });
    expect(hardDeleteMock).toHaveBeenNthCalledWith(2, 'pkg-b', { requireSoftDeleted: true });
    expect(res.body).toMatchObject({ purged: 2, totalCandidates: 2, filesRemoved: 2, filesAlreadyMissing: 0 });
    expect(logAuditMock).toHaveBeenCalledWith('BOTADMIN_DANGER_PURGE_PACKAGES', 'ADMIN', expect.any(Object));
    expect(logAuditDbMock).toHaveBeenCalled();
  });

  it('ueberspringt ein parallel wiederhergestelltes Paket statt es physisch zu loeschen', async () => {
    hardDeleteMock
      .mockRejectedValueOnce(new MockHardDeletePackageError('Hard-Delete blockiert: Paket ist nicht mehr als geloescht markiert.', 409))
      .mockResolvedValueOnce({ filesRemoved: 2, filesAlreadyMissing: 1 });

    const res = await request(app())
      .post('/bot-admin/danger/purge-deleted-packages')
      .send({ confirm: 'DELETE' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ purged: 1, totalCandidates: 2, filesRemoved: 2, filesAlreadyMissing: 1 });
  });

  it('bricht bei echtem Delete-Fehler mit explizitem Partial-State ab', async () => {
    hardDeleteMock
      .mockResolvedValueOnce({ filesRemoved: 1, filesAlreadyMissing: 0 })
      .mockRejectedValueOnce(new MockHardDeletePackageError('Datei konnte nicht entfernt werden.', 500));

    const res = await request(app())
      .post('/bot-admin/danger/purge-deleted-packages')
      .send({ confirm: 'DELETE' });

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      partial: true,
      failedPackageId: 'pkg-b',
      purged: 1,
      total: 2,
      filesRemoved: 1,
    });
    expect(logAuditMock).toHaveBeenCalledWith('BOTADMIN_DANGER_PURGE_ABORTED', 'ADMIN', expect.objectContaining({ failedPackageId: 'pkg-b' }));
    expect(logAuditDbMock).toHaveBeenCalled();
  });
});
