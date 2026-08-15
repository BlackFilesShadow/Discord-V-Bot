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
    package: {
      findUnique: jest.fn(),
      delete: jest.fn(),
    },
  },
}));

jest.mock('../../src/utils/pathSafety', () => ({
  isInsideUploadRoot: jest.fn(),
  isInsideRoot: jest.fn(),
}));

import fs from 'node:fs/promises';
import prisma from '../../src/database/prisma';
import { config } from '../../src/config';
import { isInsideRoot, isInsideUploadRoot } from '../../src/utils/pathSafety';
import { hardDeletePackage, HardDeletePackageError } from '../../src/modules/packages/hardDeletePackage';

const unlinkMock = fs.unlink as jest.Mock;
const realpathMock = fs.realpath as jest.Mock;
const insideUploadMock = isInsideUploadRoot as jest.MockedFunction<typeof isInsideUploadRoot>;
const insideRootMock = isInsideRoot as jest.MockedFunction<typeof isInsideRoot>;
const findMock = prisma.package.findUnique as jest.Mock;
const deleteMock = prisma.package.delete as jest.Mock;
const REAL_ROOT = '/real/uploads';

describe('hardDeletePackage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    insideUploadMock.mockReturnValue(true);
    insideRootMock.mockReturnValue(true);
    realpathMock.mockImplementation(async (target: string) => {
      if (target === config.upload.dir) return REAL_ROOT;
      return String(target).replace(/^\/uploads/, REAL_ROOT);
    });
    unlinkMock.mockResolvedValue(undefined);
    deleteMock.mockResolvedValue({ id: 'pkg' });
  });

  it('blockiert jeden lexikalischen Pfad ausserhalb des Upload-Root bevor Dateien geloescht werden', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }, { filePath: '/etc/passwd' }] });
    insideUploadMock.mockImplementation(path => path.startsWith('/uploads/'));

    await expect(hardDeletePackage('pkg')).rejects.toMatchObject({ status: 409 });
    expect(realpathMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('blockiert Symlink-/Junction-Escapes nach realpath vor dem ersten unlink', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/evil.xml' }] });
    realpathMock.mockImplementation(async (target: string) => target === config.upload.dir ? REAL_ROOT : '/etc/passwd');
    insideRootMock.mockReturnValue(false);

    await expect(hardDeletePackage('pkg')).rejects.toMatchObject({ status: 409 });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('toleriert bereits im Preflight fehlende Dateien fuer sichere Retries', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }, { filePath: '/uploads/b.xml' }] });
    realpathMock.mockImplementation(async (target: string) => {
      if (target === config.upload.dir) return REAL_ROOT;
      if (target === '/uploads/b.xml') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return '/real/uploads/a.xml';
    });

    await expect(hardDeletePackage('pkg')).resolves.toEqual({ filesRemoved: 1, filesAlreadyMissing: 1 });
    expect(unlinkMock).toHaveBeenCalledTimes(1);
    expect(unlinkMock).toHaveBeenCalledWith('/uploads/a.xml');
    expect(deleteMock).toHaveBeenCalledWith({ where: { id: 'pkg' } });
  });

  it('bricht bei echten unlink-I/O-Fehlern ab und behaelt die DB-Zeile fuer Diagnose und Retry', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }] });
    unlinkMock.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    await expect(hardDeletePackage('pkg')).rejects.toMatchObject({ status: 500 });
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('prueft den realen Pfad direkt vor unlink erneut und blockiert spaeten Escape', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }] });
    let fileResolveCount = 0;
    realpathMock.mockImplementation(async (target: string) => {
      if (target === config.upload.dir) return REAL_ROOT;
      fileResolveCount += 1;
      return fileResolveCount === 1 ? '/real/uploads/a.xml' : '/etc/passwd';
    });
    insideRootMock
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    await expect(hardDeletePackage('pkg')).rejects.toMatchObject({ status: 409 });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it('loescht die DB-Cascade erst nachdem alle physischen Dateien bereinigt sind', async () => {
    findMock.mockResolvedValue({ id: 'pkg', files: [{ filePath: '/uploads/a.xml' }, { filePath: '/uploads/b.xml' }] });

    await hardDeletePackage('pkg');

    expect(unlinkMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    const secondUnlinkOrder = unlinkMock.mock.invocationCallOrder[1];
    const dbDeleteOrder = deleteMock.mock.invocationCallOrder[0];
    expect(dbDeleteOrder).toBeGreaterThan(secondUnlinkOrder);
  });

  it('liefert einen typisierten Fehler fuer unbekannte Pakete', async () => {
    findMock.mockResolvedValue(null);
    await expect(hardDeletePackage('missing')).rejects.toBeInstanceOf(HardDeletePackageError);
    await expect(hardDeletePackage('missing')).rejects.toMatchObject({ status: 404 });
  });
});
