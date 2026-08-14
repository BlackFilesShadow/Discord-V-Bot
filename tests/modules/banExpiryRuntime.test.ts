jest.mock('../../src/database/prisma', () => {
  const prisma: Record<string, any> = {
    serverBanEntry: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
      findFirst: jest.fn(),
    },
    serverBanExpiryNotice: {
      updateMany: jest.fn(),
      findMany: jest.fn(),
    },
    nitradoConnection: { findFirst: jest.fn() },
    nitradoJob: { findMany: jest.fn(), create: jest.fn() },
  };
  prisma.$transaction = jest.fn(async (arg: any) => {
    if (typeof arg === 'function') return arg(prisma);
    return Promise.all(arg);
  });
  return { __esModule: true, default: prisma };
});

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '12345678901234567890123456789012' } },
}));

import prisma from '../../src/database/prisma';
import { tryGetDashboardClient } from '../../src/dashboard/clientRegistry';
import {
  reconcileExpiredServerBansOnce,
  runBanExpiryRuntimeOnce,
} from '../../src/modules/bans/expiryRuntime';

const db = prisma as any;
const getClient = tryGetDashboardClient as jest.Mock;
const NOW = new Date('2026-08-15T00:00:10.000Z');

beforeEach(() => {
  jest.clearAllMocks();
  db.nitradoJob.findMany.mockResolvedValue([]);
  db.nitradoJob.create.mockResolvedValue({});
  db.serverBanExpiryNotice.updateMany.mockResolvedValue({ count: 1 });
  db.serverBanExpiryNotice.findMany.mockResolvedValue([]);
});

describe('timed server-ban expiry', () => {
  it('reiht bei erreichtem Ablauf zuerst den Remote-Unban ein', async () => {
    db.serverBanEntry.findMany.mockResolvedValue([{
      id: 'ban-1', guildId: 'g1', nitradoConnId: 'n1', appliedRemotely: true,
    }]);

    await reconcileExpiredServerBansOnce(NOW);

    expect(db.nitradoJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        guildId: 'g1',
        nitradoConnId: 'n1',
        operation: 'SERVER_BAN_REMOVE',
        payload: { banId: 'ban-1' },
      }),
    }));
    expect(db.serverBanEntry.updateMany).not.toHaveBeenCalled();
  });

  it('finalisiert erst nach bestaetigtem Remote-Remove und gibt dann die Notice frei', async () => {
    db.serverBanEntry.findMany.mockResolvedValue([{
      id: 'ban-2', guildId: 'g2', nitradoConnId: 'n2', appliedRemotely: false,
    }]);
    db.serverBanEntry.updateMany.mockResolvedValue({ count: 1 });

    await reconcileExpiredServerBansOnce(NOW);

    expect(db.serverBanEntry.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'ban-2', guildId: 'g2', nitradoConnId: 'n2', active: true, appliedRemotely: false,
      }),
      data: { active: false, liftedAt: NOW },
    }));
    expect(db.serverBanExpiryNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ banId: 'ban-2', status: 'PENDING' }),
      data: expect.objectContaining({ status: 'READY', remoteRemovedAt: NOW }),
    }));
  });

  it('sendet die Ablaufmeldung im gespeicherten Command-Kanal genau nach Remote-Finalisierung', async () => {
    db.serverBanEntry.findMany.mockResolvedValue([]);
    db.serverBanExpiryNotice.findMany.mockResolvedValue([{
      id: 'notice-1',
      banId: 'ban-3',
      guildId: 'g3',
      nitradoConnId: 'n3',
      channelId: 'channel-1',
      identifierEnc: null,
      expiresAt: new Date('2026-08-15T00:00:00.000Z'),
      attempts: 0,
    }]);
    db.serverBanEntry.findFirst.mockResolvedValue({
      reason: 'Testgrund', liftedAt: NOW,
    });
    db.nitradoConnection.findFirst.mockResolvedValue({ alias: 'Test1', slot: 1 });

    const send = jest.fn().mockResolvedValue({ id: 'discord-message-1' });
    const fetchMessages = jest.fn().mockResolvedValue(new Map());
    const channel = {
      guildId: 'g3',
      isTextBased: () => true,
      isDMBased: () => false,
      messages: { fetch: fetchMessages },
      client: { user: { id: 'bot-user' } },
      send,
    };
    getClient.mockReturnValue({
      channels: { fetch: jest.fn().mockResolvedValue(channel) },
    });

    await runBanExpiryRuntimeOnce(NOW);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      embeds: [expect.objectContaining({ data: expect.objectContaining({ title: '✅ Server-Bann abgelaufen' }) })],
      allowedMentions: { parse: [] },
    }));
    expect(db.serverBanExpiryNotice.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'notice-1', status: 'SENDING' },
      data: expect.objectContaining({ status: 'SENT', messageId: 'discord-message-1', identifierEnc: null }),
    }));
  });

  it('sendet keine Meldung fuer CANCELLED/manuelle Unbans, weil nur READY geladen wird', async () => {
    db.serverBanEntry.findMany.mockResolvedValue([]);
    db.serverBanExpiryNotice.findMany.mockResolvedValue([]);
    getClient.mockReturnValue(null);

    await runBanExpiryRuntimeOnce(NOW);

    expect(getClient).not.toHaveBeenCalled();
    expect(db.serverBanExpiryNotice.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'READY', nextAttemptAt: { lte: NOW } },
    }));
  });
});
