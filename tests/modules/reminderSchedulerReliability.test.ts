const txMock = {
  $queryRawUnsafe: jest.fn(),
  reminder: {
    findUnique: jest.fn(),
    update: jest.fn(),
  },
};

const prismaMock = {
  $transaction: jest.fn(async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock)),
  reminder: { findMany: jest.fn() },
};

const safeSendMock = jest.fn();
const safeDmMock = jest.fn();

jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));
jest.mock('../../src/utils/safeSend', () => ({
  safeSend: (...args: unknown[]) => safeSendMock(...args),
  safeDm: (...args: unknown[]) => safeDmMock(...args),
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import { fireReminderById, runReminderTickOnce } from '../../src/modules/reminders/reminderScheduler';

function makeClient() {
  return {
    channels: { fetch: jest.fn() },
    users: { fetch: jest.fn() },
  };
}

const dueReminder = {
  id: 'rem-1',
  userId: 'user-1',
  channelId: 'chan-1',
  message: 'Nicht vergessen',
  isRecurring: false,
  recurrenceMs: null,
  fireCount: 0,
  dueAt: new Date(Date.now() - 60_000),
  isActive: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  txMock.$queryRawUnsafe.mockResolvedValue([]);
  txMock.reminder.update.mockResolvedValue({});
});

describe('Reminder scheduler reliability', () => {
  it('wertet safeSend=null nicht als Erfolg und nutzt danach DM-Fallback', async () => {
    const client = makeClient();
    const textChannel = { isTextBased: () => true };
    client.channels.fetch.mockResolvedValue(textChannel);
    client.users.fetch.mockResolvedValue({ id: 'user-1' });
    txMock.reminder.findUnique.mockResolvedValue(dueReminder);
    safeSendMock.mockResolvedValue(null);
    safeDmMock.mockResolvedValue({ id: 'dm-message' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fireReminderById(client as any, 'rem-1');

    expect(safeSendMock).toHaveBeenCalledTimes(1);
    expect(safeDmMock).toHaveBeenCalledTimes(1);
    expect(txMock.reminder.update).toHaveBeenCalledWith({
      where: { id: 'rem-1' },
      data: { isActive: false, fireCount: { increment: 1 } },
    });
  });

  it('laesst Reminder bei kompletter Zustellstoerung aktiv und plant Retry ohne fireCount', async () => {
    const client = makeClient();
    const textChannel = { isTextBased: () => true };
    client.channels.fetch.mockResolvedValue(textChannel);
    client.users.fetch.mockResolvedValue({ id: 'user-1' });
    txMock.reminder.findUnique.mockResolvedValue(dueReminder);
    safeSendMock.mockResolvedValue(null);
    safeDmMock.mockResolvedValue(null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fireReminderById(client as any, 'rem-1');

    const update = txMock.reminder.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'rem-1' });
    expect(update.data.isActive).toBeUndefined();
    expect(update.data.fireCount).toBeUndefined();
    expect(update.data.dueAt).toBeInstanceOf(Date);
    expect(update.data.dueAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('wird fuer einen bereits von anderem Worker weitergeschobenen Reminder zum No-Op', async () => {
    const client = makeClient();
    txMock.reminder.findUnique.mockResolvedValue({
      ...dueReminder,
      dueAt: new Date(Date.now() + 120_000),
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await fireReminderById(client as any, 'rem-1');

    expect(txMock.$queryRawUnsafe).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'reminder:rem-1',
    );
    expect(safeSendMock).not.toHaveBeenCalled();
    expect(safeDmMock).not.toHaveBeenCalled();
    expect(txMock.reminder.update).not.toHaveBeenCalled();
  });

  it('isoliert Fehler eines Reminders und verarbeitet den restlichen Tick weiter', async () => {
    const client = makeClient();
    prismaMock.reminder.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    prismaMock.$transaction
      .mockRejectedValueOnce(new Error('db lock failed'))
      .mockImplementationOnce(async (cb: (tx: typeof txMock) => Promise<unknown>) => {
        txMock.reminder.findUnique.mockResolvedValueOnce(null);
        return cb(txMock);
      });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(runReminderTickOnce(client as any)).resolves.toBeUndefined();
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2);
  });
});
