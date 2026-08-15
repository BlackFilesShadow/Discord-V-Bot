process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  default: { unlink: jest.fn() },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    package: {
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock('../../src/utils/pathSafety', () => ({
  isInsideUploadRoot: jest.fn(),
}));

import fs from 'node:fs/promises';
import prisma from '../../src/database/prisma';
import { isInsideUploadRoot } from '../../src/utils/pathSafety';
import { hardDeletePackage, HardDeletePackageError } from '../../src/modules/packages/hardDeletePackage';

const unlinkMock = fs.unlink as jest.MockedFunction<typeof fs.unlink>;
const insideMock = isInsideUploadRoot as jest.MockedFunction<typeof isInsideUploadRoot>;
const findMock = prisma.package.findUnique as jest.Mock;
const deleteMock = prisma.package.delete as jest.Mock;

describe('hardDeletePackage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    insideMock.mockReturnValue(true);
    deleteMock.mockResolvedValue({ id: 'pkg' });
  });

  it('blockiert jeden Pfad ausserhalb des Upload-Root bevor Dateien geloescht werden', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }, { filePath: '/etc/passwd' }] });
    insideMock.mockImplementation(path => path.startsWith('/uploads/'));

    await expect(hardDeletePackage('pkg')).rejects.toMatchObject<Partial<HardDeletePackageError>>({ status: 409 });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('toleriert bereits fehlende Dateien fuer sichere Retries und loescht danach die DB-Zeile', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }, { filePath: '/uploads/b.xml' }] });
    unlinkMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { code: 'ENOENT' }));

    await expect(hardDeletePackage('pkg')).resolves.toEqual({ filesRemoved: 1, filesAlreadyMissing: 1 });
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'pkg' } });
  });

  it('bricht bei echten I/O-Fehlern ab und behaelt die DB-Zeile fuer Diagnose und Retry', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }] });
    unlinkMock.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(hardDeletePackage('pkg')).rejects.toMatchObject<Partial<HardDeletePackageError>>({ status: 500 });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('loescht die DB-Cascade erst nachdem alle physischen Dateien bereinigt sind', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }, { filePath: '/uploads/b.xml' }] });
    unlinkMock.mockResolvedValue(undefined);

    await hardDeletePackage('pkg');

    expect(unlinkMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const secondUnlinkOrder = unlinkMock.mock.invocationCallOrder[1];
    const dbDeleteOrder = deleteMock.mock.invocationCallOrder[0];
    expect(dbDeleteOrder).toBeGreaterThan(secondUnlinkOrder);
  });
});
