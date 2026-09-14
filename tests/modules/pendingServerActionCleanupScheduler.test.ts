const deleteManyMock = jest.fn();

const prismaMock = {
  pendingServerAction: { deleteMany: deleteManyMock },
};

const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/logger', () => ({ logger: loggerMock }));

import {
  runPendingServerActionCleanupOnce,
  startPendingServerActionCleanupScheduler,
  stopPendingServerActionCleanupScheduler,
} from '../../src/modules/nitrado/pendingServerActionCleanupScheduler';

beforeEach(() => {
  jest.clearAllMocks();
  stopPendingServerActionCleanupScheduler();
});

afterEach(() => {
  stopPendingServerActionCleanupScheduler();
  jest.useRealTimers();
});

describe('PendingServerAction-Cleanup-Scheduler', () => {
  it('loescht abgelaufene Pending-Actions und loggt nur bei tatsaechlichen Treffern', async () => {
    deleteManyMock.mockResolvedValueOnce({ count: 3 });
    await expect(runPendingServerActionCleanupOnce()).resolves.toBe(3);
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
    expect(loggerMock.info).toHaveBeenCalledWith(expect.stringContaining('3'));
  });

  it('loggt nicht, wenn nichts geloescht wurde', async () => {
    deleteManyMock.mockResolvedValueOnce({ count: 0 });
    await expect(runPendingServerActionCleanupOnce()).resolves.toBe(0);
    expect(loggerMock.info).not.toHaveBeenCalled();
  });

  it('faengt einen fehlschlagenden deleteMany ab und gibt 0 zurueck', async () => {
    deleteManyMock.mockRejectedValueOnce(new Error('db down'));
    await expect(runPendingServerActionCleanupOnce()).resolves.toBe(0);
    expect(loggerMock.warn).toHaveBeenCalled();
  });

  it('startet den stuendlichen Lauf verzoegert und danach wiederkehrend, idempotent bei Mehrfachaufruf', () => {
    jest.useFakeTimers();
    deleteManyMock.mockResolvedValue({ count: 0 });

    startPendingServerActionCleanupScheduler();
    startPendingServerActionCleanupScheduler();

    expect(deleteManyMock).not.toHaveBeenCalled();

    jest.advanceTimersByTime(60_000);
    expect(deleteManyMock).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(deleteManyMock).toHaveBeenCalledTimes(2);
  });

  it('stoppt Startup- und Intervall-Timer symmetrisch', () => {
    jest.useFakeTimers();
    deleteManyMock.mockResolvedValue({ count: 0 });

    startPendingServerActionCleanupScheduler();
    stopPendingServerActionCleanupScheduler();

    jest.advanceTimersByTime(2 * 60 * 60 * 1000);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});
