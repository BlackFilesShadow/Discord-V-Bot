process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  default: { unlink: jest.fn(), realpath: jest.fn() },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    package: { findUnique: jest.fn(), delete: jest.fn() },
  },
}));

jest.mock('../../src/utils/pathSafety', () => ({
  isInsideUploadRoot: jest.fn(() => true),
  isInsideRoot: jest.fn(() => true),
}));

import fs from 'node:fs/promises';
import prisma from '../../src/database/prisma';
import { hardDeletePackage } from '../../src/modules/packages/hardDeletePackage';

const findMock = prisma.package.findUnique as jest.Mock;
const deleteMock = prisma.package.delete as jest.Mock;
const unlinkMock = fs.unlink as jest.Mock;
const realpathMock = fs.realpath as jest.Mock;

describe('hardDeletePackage soft-delete precondition', () => {
  beforeEach(() => jest.clearAllMocks());

  it('blockiert ein inzwischen wiederhergestelltes Paket vor realpath/unlink/DB-Delete', async () => {
    findMock.mockResolvedValue({ id: 'pkg', isDeleted: false, files: [{ filePath: '/uploads/a.xml' }] });

    await expect(hardDeletePackage('pkg', { requireSoftDeleted: true })).rejects.toMatchObject({ status: 409 });
    expect(realpathMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('laesst den bestehenden direkten Hard-Delete-Modus ohne Option unveraendert', async () => {
    findMock.mockResolvedValue({ id: 'pkg', isDeleted: false, files: [] });
    realpathMock.mockResolvedValue('/real/uploads');
    deleteMock.mockResolvedValue({ id: 'pkg' });

    await expect(hardDeletePackage('pkg')).resolves.toEqual({ filesRemoved: 0, filesAlreadyMissing: 0 });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'pkg' } });
  });
});
