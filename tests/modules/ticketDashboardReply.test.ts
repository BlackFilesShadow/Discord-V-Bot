const mockTicketFindUnique = jest.fn();
const mockTicketUpdate = jest.fn();
const mockTicketMessageCreate = jest.fn();
const mockWarn = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    ticket: {
      findUnique: mockTicketFindUnique,
      update: mockTicketUpdate,
    },
    ticketMessage: {
      create: mockTicketMessageCreate,
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    warn: mockWarn,
  },
}));

import { replyToOwnerTicketFromDashboard } from '../../src/modules/ticket/ticketDashboardReply';

function openTicket(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ticket-101',
    ticketNumber: 101,
    userDiscordId: 'user-1',
    ownerDiscordId: 'owner-1',
    status: 'OPEN',
    ...overrides,
  };
}

function client(sendImpl: () => Promise<unknown> = async () => ({ id: 'dm-1' })) {
  const send = jest.fn(sendImpl);
  const fetch = jest.fn().mockResolvedValue({ send });
  return {
    value: { users: { fetch } } as any,
    fetch,
    send,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTicketUpdate.mockResolvedValue({});
  mockTicketMessageCreate.mockResolvedValue({});
});

describe('dashboard owner-ticket reply', () => {
  it('stores an OWNER message and relays it only to the ticket user', async () => {
    mockTicketFindUnique.mockResolvedValue(openTicket());
    const c = client();

    const result = await replyToOwnerTicketFromDashboard({
      ticketId: 'ticket-101',
      ownerDiscordId: 'owner-1',
      content: '  Antwort aus dem Dashboard  ',
      client: c.value,
    });

    expect(result).toEqual({
      ok: true,
      ticketNumber: 101,
      userDiscordId: 'user-1',
      recorded: true,
      delivered: true,
    });
    expect(mockTicketMessageCreate).toHaveBeenCalledWith({
      data: {
        ticketId: 'ticket-101',
        fromDiscordId: 'owner-1',
        fromRole: 'OWNER',
        content: 'Antwort aus dem Dashboard',
      },
    });
    expect(mockTicketUpdate).toHaveBeenCalledWith({
      where: { id: 'ticket-101' },
      data: { updatedAt: expect.any(Date) },
    });
    expect(c.fetch).toHaveBeenCalledTimes(1);
    expect(c.fetch).toHaveBeenCalledWith('user-1');
    expect(c.send).toHaveBeenCalledWith({
      content: '**🛡️ Owner** · Ticket #101\nAntwort aus dem Dashboard',
      allowedMentions: { parse: [] },
    });
  });

  it('refuses a reply when the authenticated owner does not own the ticket', async () => {
    mockTicketFindUnique.mockResolvedValue(openTicket({ ownerDiscordId: 'owner-other' }));
    const c = client();

    const result = await replyToOwnerTicketFromDashboard({
      ticketId: 'ticket-101',
      ownerDiscordId: 'owner-1',
      content: 'Nicht erlaubt',
      client: c.value,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: 'NOT_OWNER',
      recorded: false,
      delivered: false,
    }));
    expect(mockTicketMessageCreate).not.toHaveBeenCalled();
    expect(mockTicketUpdate).not.toHaveBeenCalled();
    expect(c.fetch).not.toHaveBeenCalled();
  });

  it('refuses replies to non-OPEN tickets without changing history', async () => {
    mockTicketFindUnique.mockResolvedValue(openTicket({ status: 'CLOSED' }));
    const c = client();

    const result = await replyToOwnerTicketFromDashboard({
      ticketId: 'ticket-101',
      ownerDiscordId: 'owner-1',
      content: 'Zu spaet',
      client: c.value,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: 'NOT_OPEN',
      recorded: false,
      delivered: false,
    }));
    expect(mockTicketMessageCreate).not.toHaveBeenCalled();
    expect(mockTicketUpdate).not.toHaveBeenCalled();
    expect(c.fetch).not.toHaveBeenCalled();
  });

  it('reports a delivery failure explicitly while preserving the recorded history entry', async () => {
    mockTicketFindUnique.mockResolvedValue(openTicket());
    const c = client(async () => { throw new Error('DM blocked'); });

    const result = await replyToOwnerTicketFromDashboard({
      ticketId: 'ticket-101',
      ownerDiscordId: 'owner-1',
      content: 'Kannst du mich lesen?',
      client: c.value,
    });

    expect(result).toEqual(expect.objectContaining({
      ok: false,
      code: 'DELIVERY_FAILED',
      ticketNumber: 101,
      recorded: true,
      delivered: false,
    }));
    expect(mockTicketMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockTicketUpdate).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('rejects empty or oversized dashboard messages before touching the database', async () => {
    const c = client();

    await expect(replyToOwnerTicketFromDashboard({
      ticketId: 'ticket-101',
      ownerDiscordId: 'owner-1',
      content: '   ',
      client: c.value,
    })).rejects.toThrow('zwischen 1 und 1800 Zeichen');

    await expect(replyToOwnerTicketFromDashboard({
      ticketId: 'ticket-101',
      ownerDiscordId: 'owner-1',
      content: 'x'.repeat(1801),
      client: c.value,
    })).rejects.toThrow('zwischen 1 und 1800 Zeichen');

    expect(mockTicketFindUnique).not.toHaveBeenCalled();
    expect(mockTicketMessageCreate).not.toHaveBeenCalled();
    expect(c.fetch).not.toHaveBeenCalled();
  });
});
