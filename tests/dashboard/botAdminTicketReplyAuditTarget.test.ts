import express from 'express';
import request from 'supertest';

const DISCORD_ID = '1498019924424130666';
const findUserByDiscordId = jest.fn();
const logAuditDb = jest.fn();
const replyToOwnerTicketFromDashboard = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...args: unknown[]) => findUserByDiscordId(...args) },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logAuditDb: (...args: unknown[]) => logAuditDb(...args),
}));

jest.mock('../../src/modules/ticket/ticketDashboardReply', () => ({
  replyToOwnerTicketFromDashboard: (...args: unknown[]) => replyToOwnerTicketFromDashboard(...args),
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  tryGetDashboardClient: jest.fn(() => ({ id: 'dashboard-client' })),
}));

const allow = (req: { auth?: unknown }, _res: unknown, next: () => void): void => {
  req.auth = { userId: 'actor-internal-id', discordId: 'owner-discord-id', role: 'BOT_ADMIN' };
  next();
};

jest.mock('../../src/dashboard/middleware/auth', () => ({ requireBotAdmin: allow }));
jest.mock('../../src/dashboard/middleware/globalDeveloperGate', () => ({ requireGlobalDeveloperIdentity: allow }));

import { botAdminTicketReplyRouter } from '../../src/dashboard/routes/v2/botAdminTicketReply';

function app() {
  const instance = express();
  instance.use(express.json());
  instance.use('/tickets', botAdminTicketReplyRouter);
  return instance;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BotAdmin owner-ticket reply audit target', () => {
  it('resolves a ticket recipient Discord snowflake to User.id before persisting a successful reply audit', async () => {
    findUserByDiscordId.mockResolvedValue({ id: 'recipient-internal-id' });
    replyToOwnerTicketFromDashboard.mockResolvedValue({
      ok: true,
      ticketNumber: 42,
      userDiscordId: DISCORD_ID,
      recorded: true,
      delivered: true,
    });

    const response = await request(app()).post('/tickets/ticket-42/reply').send({ content: 'Antwort' });

    expect(response.status).toBe(200);
    expect(findUserByDiscordId).toHaveBeenCalledWith({
      where: { discordId: DISCORD_ID },
      select: { id: true },
    });
    expect(logAuditDb).toHaveBeenCalledWith('BOTADMIN_TICKET_REPLY', 'TICKET', expect.objectContaining({
      actorUserId: 'actor-internal-id',
      targetUserId: 'recipient-internal-id',
      details: expect.objectContaining({ targetDiscordId: DISCORD_ID, delivered: true }),
    }));
    expect(logAuditDb.mock.calls[0][2].targetUserId).not.toBe(DISCORD_ID);
  });

  it('persists null targetId metadata, never a missing recipient snowflake, after delivery failure', async () => {
    findUserByDiscordId.mockResolvedValue(null);
    replyToOwnerTicketFromDashboard.mockResolvedValue({
      ok: false,
      code: 'DELIVERY_FAILED',
      message: 'DM konnte nicht zugestellt werden.',
      ticketNumber: 42,
      userDiscordId: DISCORD_ID,
      recorded: true,
      delivered: false,
    });

    const response = await request(app()).post('/tickets/ticket-42/reply').send({ content: 'Antwort' });

    expect(response.status).toBe(502);
    expect(logAuditDb).toHaveBeenCalledWith('BOTADMIN_TICKET_REPLY_DELIVERY_FAILED', 'TICKET', expect.objectContaining({
      actorUserId: 'actor-internal-id',
      targetUserId: null,
      details: expect.objectContaining({ targetDiscordId: DISCORD_ID, delivered: false }),
    }));
    expect(logAuditDb.mock.calls[0][2].targetUserId).not.toBe(DISCORD_ID);
  });
});
