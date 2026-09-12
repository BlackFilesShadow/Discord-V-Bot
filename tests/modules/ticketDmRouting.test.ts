const mockTicketFindMany = jest.fn();
const mockTicketUpdate = jest.fn();
const mockTicketMessageCreate = jest.fn();
const mockLogAudit = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    ticket: {
      findMany: mockTicketFindMany,
      update: mockTicketUpdate,
    },
    ticketMessage: {
      create: mockTicketMessageCreate,
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  logger: {
    warn: jest.fn(),
  },
  logAudit: mockLogAudit,
}));

jest.mock('../../src/utils/embedDesign', () => ({
  Colors: {
    Info: 0x5865f2,
    Warning: 0xfee75c,
    Success: 0x57f287,
    Error: 0xed4245,
  },
  Brand: { divider: '---' },
  vEmbed: jest.fn(() => ({
    setTitle: jest.fn().mockReturnThis(),
    setDescription: jest.fn().mockReturnThis(),
    addFields: jest.fn().mockReturnThis(),
  })),
}));

import { handleTicketDm } from '../../src/modules/ticket/ticketManager';

type OpenTicket = {
  id: string;
  ticketNumber: number;
  userDiscordId: string;
  ownerDiscordId: string;
  username: string;
  subject: string;
  status: 'OPEN';
  updatedAt: Date;
};

function ticket(overrides: Partial<OpenTicket> = {}): OpenTicket {
  return {
    id: 'ticket-101',
    ticketNumber: 101,
    userDiscordId: 'user-1',
    ownerDiscordId: 'owner-1',
    username: 'User One',
    subject: 'Hilfe benoetigt',
    status: 'OPEN',
    updatedAt: new Date('2026-09-12T00:00:00.000Z'),
    ...overrides,
  };
}

function dmMessage(opts: {
  authorId: string;
  content?: string;
  referenceMessageId?: string;
  referencedMessage?: unknown;
  referenceFailure?: Error;
}) {
  // Discord.js stellt auf eingehenden und gesendeten Messages immer eine
  // Attachment-Collection bereit, auch wenn sie leer ist. Das Routing-Fixture
  // bildet diesen realen Message-Vertrag ab, damit Attachment-Hardening nicht
  // faelschlich als Routingfehler gewertet wird.
  const targetSend = jest.fn().mockResolvedValue({
    id: 'relay-message',
    attachments: new Map(),
    delete: jest.fn().mockResolvedValue(undefined),
  });
  const fetchUser = jest.fn().mockResolvedValue({ send: targetSend });
  const reply = jest.fn().mockResolvedValue({ id: 'reply-message' });
  const react = jest.fn().mockResolvedValue(undefined);
  const fetchReference = opts.referenceFailure
    ? jest.fn().mockRejectedValue(opts.referenceFailure)
    : jest.fn().mockResolvedValue(opts.referencedMessage ?? null);

  const msg = {
    author: { id: opts.authorId },
    content: opts.content ?? 'Hallo Ticket',
    attachments: new Map(),
    reference: opts.referenceMessageId ? { messageId: opts.referenceMessageId } : null,
    fetchReference,
    client: { users: { fetch: fetchUser } },
    reply,
    react,
  } as any;

  return { msg, targetSend, fetchUser, reply, react, fetchReference };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTicketUpdate.mockResolvedValue({});
  mockTicketMessageCreate.mockResolvedValue({});
});

describe('ticket owner-DM relay routing regression', () => {
  it('routes a user DM only to the owner of that OPEN ticket', async () => {
    const open = ticket();
    mockTicketFindMany.mockResolvedValue([open]);
    const { msg, fetchUser, targetSend, reply, react } = dmMessage({
      authorId: 'user-1',
      content: 'Bitte pruefen',
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(mockTicketFindMany).toHaveBeenCalledWith({
      where: {
        status: 'OPEN',
        OR: [{ userDiscordId: 'user-1' }, { ownerDiscordId: 'user-1' }],
      },
      orderBy: { updatedAt: 'desc' },
      take: 50,
    });
    expect(mockTicketMessageCreate).toHaveBeenCalledWith({
      data: {
        ticketId: 'ticket-101',
        fromDiscordId: 'user-1',
        fromRole: 'USER',
        content: 'Bitte pruefen',
      },
    });
    expect(fetchUser).toHaveBeenCalledWith('owner-1');
    expect(targetSend).toHaveBeenCalledWith({
      content: '**👤 User One** · Ticket #101\nBitte pruefen',
      allowedMentions: { parse: [] },
    });
    expect(mockTicketUpdate).toHaveBeenCalledWith({
      where: { id: 'ticket-101' },
      data: { updatedAt: expect.any(Date) },
    });
    expect(react).toHaveBeenCalledWith('📨');
    expect(reply).toHaveBeenCalledWith({
      content: '↳ weitergeleitet · Ticket #101',
      allowedMentions: { parse: [] },
    });
  });

  it('routes an owner DM to the user when exactly one OPEN owner ticket exists', async () => {
    const open = ticket();
    mockTicketFindMany.mockResolvedValue([open]);
    const { msg, fetchUser, targetSend } = dmMessage({
      authorId: 'owner-1',
      content: 'Antwort vom Owner',
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(mockTicketMessageCreate).toHaveBeenCalledWith({
      data: {
        ticketId: 'ticket-101',
        fromDiscordId: 'owner-1',
        fromRole: 'OWNER',
        content: 'Antwort vom Owner',
      },
    });
    expect(fetchUser).toHaveBeenCalledWith('user-1');
    expect(targetSend).toHaveBeenCalledWith({
      content: '**🛡️ Owner** · Ticket #101\nAntwort vom Owner',
      allowedMentions: { parse: [] },
    });
  });

  it('never guesses a destination when the owner has multiple OPEN tickets', async () => {
    mockTicketFindMany.mockResolvedValue([
      ticket(),
      ticket({
        id: 'ticket-202',
        ticketNumber: 202,
        userDiscordId: 'user-2',
        username: 'User Two',
        subject: 'Zweites Ticket',
      }),
    ]);
    const { msg, fetchUser, reply, fetchReference } = dmMessage({
      authorId: 'owner-1',
      content: 'Nicht eindeutig',
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(fetchReference).not.toHaveBeenCalled();
    expect(mockTicketMessageCreate).not.toHaveBeenCalled();
    expect(mockTicketUpdate).not.toHaveBeenCalled();
    expect(fetchUser).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toEqual(expect.objectContaining({
      embeds: expect.any(Array),
      allowedMentions: { parse: [] },
    }));
  });

  it('routes a multi-ticket owner reply only to the OPEN ticket named by the referenced bot message', async () => {
    const first = ticket();
    const second = ticket({
      id: 'ticket-202',
      ticketNumber: 202,
      userDiscordId: 'user-2',
      username: 'User Two',
      subject: 'Zweites Ticket',
    });
    mockTicketFindMany.mockResolvedValue([first, second]);
    const { msg, fetchReference, fetchUser, targetSend } = dmMessage({
      authorId: 'owner-1',
      content: 'Nur fuer Ticket 202',
      referenceMessageId: 'discord-message-202',
      referencedMessage: {
        content: '**👤 User Two** · Ticket #202\nVorherige Nachricht',
        embeds: [],
      },
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(fetchReference).toHaveBeenCalledTimes(1);
    expect(mockTicketMessageCreate).toHaveBeenCalledTimes(1);
    expect(mockTicketMessageCreate).toHaveBeenCalledWith({
      data: {
        ticketId: 'ticket-202',
        fromDiscordId: 'owner-1',
        fromRole: 'OWNER',
        content: 'Nur fuer Ticket 202',
      },
    });
    expect(fetchUser).toHaveBeenCalledTimes(1);
    expect(fetchUser).toHaveBeenCalledWith('user-2');
    expect(fetchUser).not.toHaveBeenCalledWith('user-1');
    expect(targetSend).toHaveBeenCalledWith({
      content: '**🛡️ Owner** · Ticket #202\nNur fuer Ticket 202',
      allowedMentions: { parse: [] },
    });
  });

  it('does not forward when a reply names a ticket that is not in the owner OPEN-ticket set', async () => {
    mockTicketFindMany.mockResolvedValue([
      ticket(),
      ticket({
        id: 'ticket-202',
        ticketNumber: 202,
        userDiscordId: 'user-2',
        username: 'User Two',
        subject: 'Zweites Ticket',
      }),
    ]);
    const { msg, fetchUser, reply } = dmMessage({
      authorId: 'owner-1',
      content: 'Stale Zuordnung',
      referenceMessageId: 'discord-message-stale',
      referencedMessage: {
        content: '🛡️ Owner · Ticket #999',
        embeds: [],
      },
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(mockTicketMessageCreate).not.toHaveBeenCalled();
    expect(mockTicketUpdate).not.toHaveBeenCalled();
    expect(fetchUser).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it('does not forward when the referenced Discord message is stale or cannot be fetched', async () => {
    mockTicketFindMany.mockResolvedValue([
      ticket(),
      ticket({
        id: 'ticket-202',
        ticketNumber: 202,
        userDiscordId: 'user-2',
        username: 'User Two',
        subject: 'Zweites Ticket',
      }),
    ]);
    const { msg, fetchReference, fetchUser, reply } = dmMessage({
      authorId: 'owner-1',
      content: 'Keine unsichere Weiterleitung',
      referenceMessageId: 'deleted-discord-message',
      referenceFailure: new Error('Unknown Message'),
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(fetchReference).toHaveBeenCalledTimes(1);
    expect(mockTicketMessageCreate).not.toHaveBeenCalled();
    expect(mockTicketUpdate).not.toHaveBeenCalled();
    expect(fetchUser).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
  });
});
