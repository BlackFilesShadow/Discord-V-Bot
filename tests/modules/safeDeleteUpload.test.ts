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
    upload: { findUnique: jest.fn(), update: jest.fn() },
    package: { update: jest.fn() },
    $transaction: jest.fn(),
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
import { safeDeleteUpload, SafeDeleteUploadError } from '../../src/modules/packages/safeDeleteUpload';

const findMock = prisma.upload.findUnique as jest.Mock;
const updateUploadMock = prisma.upload.update as jest.Mock;
const updatePackageMock = prisma.package.update as jest.Mock;
const txMock = prisma.$transaction as jest.Mock;
const realpathMock = fs.realpath as jest.Mock;
const unlinkMock = fs.unlink as jest.Mock;
const insideUploadMock = isInsideUploadRoot as jest.MockedFunction<typeof isInsideUploadRoot>;
const insideRootMock = isInsideRoot as jest.MockedFunction<typeof isInsideRoot>;
const REAL_ROOT = '/real/uploads';

const UPLOAD = {
  id: 'upload-1',
  packageId: 'pkg-1',
  originalName: 'a.xml',
  filePath: '/uploads/a.xml',
  fileSize: 123,
  isDeleted: false,
};

describe('safeDeleteUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMock.mockResolvedValue(UPLOAD);
    insideUploadMock.mockReturnValue(true);
    insideRootMock.mockReturnValue(true);
    realpathMock.mockImplementation(async (target: string) => target === config.upload.dir ? REAL_ROOT : '/real/uploads/a.xml');
    unlinkMock.mockResolvedValue(undefined);
    updateUploadMock.mockReturnValue({ op: 'upload' });
    updatePackageMock.mockReturnValue({ op: 'package' });
    txMock.mockResolvedValue([]);
  });

  it('blockiert lexikalische Pfade ausserhalb des Upload-Root vor I/O und DB', async () => {
    insideUploadMock.mockReturnValue(false);
    await expect(safeDeleteUpload(UPLOAD.id)).rejects.toMatchObject({ status: 409 });
    expect(realpathMock).not.toHaveBeenCalled();
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(txMock).not.toHaveBeenCalled();
  });

  it('blockiert Symlink-/Junction-Escapes vor dem ersten unlink', async () => {
    realpathMock.mockImplementation(async (target: string) => target === config.upload.dir ? REAL_ROOT : '/etc/passwd');
    insideRootMock.mockReturnValue(false);
    await expect(safeDeleteUpload(UPLOAD.id)).rejects.toMatchObject({ status: 409 });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(txMock).not.toHaveBeenCalled();
  });

  it('toleriert ENOENT und persistiert den Delete retry-sicher', async () => {
    realpathMock.mockImplementation(async (target: string) => {
      if (target === config.upload.dir) return REAL_ROOT;
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    });
    await expect(safeDeleteUpload(UPLOAD.id)).resolves.toMatchObject({
      id: UPLOAD.id,
      fileRemoved: false,
      fileAlreadyMissing: true,
    });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(txMock).toHaveBeenCalledTimes(1);
  });

  it('bricht bei echtem unlink-I/O-Fehler vor der DB-Mutation ab', async () => {
    unlinkMock.mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    await expect(safeDeleteUpload(UPLOAD.id)).rejects.toMatchObject({ status: 500 });
    expect(txMock).not.toHaveBeenCalled();
  });

  it('prueft den realen Pfad direkt vor unlink erneut', async () => {
    let fileResolves = 0;
    realpathMock.mockImplementation(async (target: string) => {
      if (target === config.upload.dir) return REAL_ROOT;
      fileResolves += 1;
      return fileResolves === 1 ? '/real/uploads/a.xml' : '/etc/passwd';
    });
    insideRootMock.mockReturnValueOnce(true).mockReturnValueOnce(false);
    await expect(safeDeleteUpload(UPLOAD.id)).rejects.toMatchObject({ status: 409 });
    expect(unlinkMock).not.toHaveBeenCalled();
    expect(txMock).not.toHaveBeenCalled();
  });

  it('entfernt die Datei vor der gemeinsamen Upload-/Paketstatistik-Mutation', async () => {
    await expect(safeDeleteUpload(UPLOAD.id)).resolves.toMatchObject({ fileRemoved: true, fileAlreadyMissing: false });
    expect(unlinkMock).toHaveBeenCalledWith(UPLOAD.filePath);
    expect(txMock).toHaveBeenCalledWith([{ op: 'upload' }, { op: 'package' }]);
    expect(updateUploadMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: UPLOAD.id } }));
    expect(updatePackageMock).toHaveBeenCalledWith(expect.objectContaining({ where: { id: UPLOAD.packageId } }));
    expect(txMock.mock.invocationCallOrder[0]).toBeGreaterThan(unlinkMock.mock.invocationCallOrder[0]);
  });

  it('liefert einen typisierten 404 fuer unbekannte oder bereits geloeschte Uploads', async () => {
    findMock.mockResolvedValue(null);
    await expect(safeDeleteUpload('missing')).rejects.toBeInstanceOf(SafeDeleteUploadError);
    await expect(safeDeleteUpload('missing')).rejects.toMatchObject({ status: 404 });
  });
});
