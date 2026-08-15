process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  default: { stat: jest.fn() },
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    upload: { findUnique: jest.fn(), update: jest.fn() },
    validationResult: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

jest.mock('../../src/utils/pathSafety', () => ({ isInsideUploadRoot: jest.fn() }));
jest.mock('../../src/utils/validator', () => ({ validateFile: jest.fn() }));
jest.mock('../../src/utils/safeSend', () => ({ withTimeout: jest.fn() }));

import fs from 'node:fs/promises';
import prisma from '../../src/database/prisma';
import { isInsideUploadRoot } from '../../src/utils/pathSafety';
import { validateFile } from '../../src/utils/validator';
import { withTimeout } from '../../src/utils/safeSend';
import { safeValidateUpload, SafeUploadValidationError } from '../../src/modules/dashboard/safeUploadValidation';

const statMock = fs.stat as jest.MockedFunction<typeof fs.stat>;
const insideMock = isInsideUploadRoot as jest.MockedFunction<typeof isInsideUploadRoot>;
const validateMock = validateFile as jest.MockedFunction<typeof validateFile>;
const timeoutMock = withTimeout as jest.MockedFunction<typeof withTimeout>;
const findMock = prisma.upload.findUnique as jest.Mock;
const updateMock = prisma.upload.update as jest.Mock;
const createResultMock = prisma.validationResult.create as jest.Mock;
const transactionMock = prisma.$transaction as jest.Mock;

const upload = {
  id: 'upload-1',
  packageId: 'package-1',
  filePath: '/uploads/test.xml',
  originalName: 'test.xml',
};

const validation = {
  isValid: true,
  errors: [],
  warnings: [],
  suggestions: [],
};

describe('safeValidateUpload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    findMock.mockResolvedValue(upload);
    insideMock.mockReturnValue(true);
    statMock.mockResolvedValue({ size: 1024 } as never);
    validateMock.mockResolvedValue(validation as never);
    timeoutMock.mockResolvedValue(validation as never);
    updateMock.mockReturnValue({ op: 'update' });
    createResultMock.mockReturnValue({ op: 'create' });
    transactionMock.mockResolvedValue([]);
  });

  it('blockiert manipulierte DB-Pfade ausserhalb des Upload-Root', async () => {
    insideMock.mockReturnValue(false);
    await expect(safeValidateUpload(upload.id, 'admin')).rejects.toMatchObject({ status: 409 });
    expect(statMock).not.toHaveBeenCalled();
    expect(timeoutMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('blockiert Dateien groesser als 50 MB vor dem Validator', async () => {
    statMock.mockResolvedValue({ size: 50 * 1024 * 1024 + 1 } as never);
    await expect(safeValidateUpload(upload.id, 'admin')).rejects.toMatchObject({ status: 413 });
    expect(timeoutMock).not.toHaveBeenCalled();
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('meldet fehlende Dateien als 404', async () => {
    statMock.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    await expect(safeValidateUpload(upload.id, 'admin')).rejects.toMatchObject({ status: 404 });
    expect(timeoutMock).not.toHaveBeenCalled();
  });

  it('begrenzt die On-Demand-Validierung auf 30 Sekunden', async () => {
    timeoutMock.mockResolvedValue(null as never);
    await expect(safeValidateUpload(upload.id, 'admin')).rejects.toMatchObject({ status: 504 });
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it('schreibt Upload-Status und ValidationResult atomar nach erfolgreicher Validierung', async () => {
    const result = await safeValidateUpload(upload.id, 'admin-1');
    expect(validateMock).toHaveBeenCalledWith(upload.filePath);
    expect(timeoutMock).toHaveBeenCalledWith(expect.any(Promise), 30_000, `dashboardValidate:${upload.id}`);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: upload.id },
      data: { isValid: true, validationStatus: 'VALID' },
    });
    expect(createResultMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ uploadId: upload.id, packageId: upload.packageId, validatedBy: 'admin-1', isValid: true }),
    }));
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: upload.id, name: upload.originalName, isValid: true });
  });

  it('liefert einen typisierten 404-Fehler fuer unbekannte Uploads', async () => {
    findMock.mockResolvedValue(null);
    await expect(safeValidateUpload('missing', 'admin')).rejects.toBeInstanceOf(SafeUploadValidationError);
    await expect(safeValidateUpload('missing', 'admin')).rejects.toMatchObject({ status: 404 });
  });
});
