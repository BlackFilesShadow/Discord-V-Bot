const mockTicketFindMany = jest.fn();
const mockTicketUpdate = jest.fn();
const mockTicketMessageCreate = jest.fn();
const mockLogAudit = jest.fn();
const mockLoggerWarn = jest.fn();

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
    warn: mockLoggerWarn,
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

type RelayAttachment = {
  id: string;
  name: string | null;
  url: string;
  size: number;
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

function attachment(overrides: Partial<RelayAttachment> = {}): RelayAttachment {
  return {
    id: '222222222222222222',
    name: 'proof.png',
    url: 'https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/proof.png?ex=123&is=456&hm=abc',
    size: 4,
    ...overrides,
  };
}

function dmMessage(opts: {
  authorId: string;
  content?: string;
  attachments?: RelayAttachment[];
  referenceMessageId?: string;
  referencedMessage?: unknown;
}) {
  const targetSend = jest.fn().mockResolvedValue({ id: 'relay-message' });
  const fetchUser = jest.fn().mockResolvedValue({ send: targetSend });
  const reply = jest.fn().mockResolvedValue({ id: 'reply-message' });
  const react = jest.fn().mockResolvedValue(undefined);
  const fetchReference = jest.fn().mockResolvedValue(opts.referencedMessage ?? null);
  const attachments = new Map((opts.attachments ?? []).map(item => [item.id, item]));

  const msg = {
    author: { id: opts.authorId },
    content: opts.content ?? 'Hallo Ticket',
    attachments,
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

describe('ticket owner-DM attachment relay', () => {
  it('relays a Discord CDN attachment in the same user-to-owner DM payload', async () => {
    mockTicketFindMany.mockResolvedValue([ticket()]);
    const proof = attachment();
    const { msg, targetSend, react, reply } = dmMessage({
      authorId: 'user-1',
      content: 'Hier ist der Beweis',
      attachments: [proof],
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(mockTicketMessageCreate).toHaveBeenCalledWith({
      data: {
        ticketId: 'ticket-101',
        fromDiscordId: 'user-1',
        fromRole: 'USER',
        content: 'Hier ist der Beweis',
      },
    });
    expect(targetSend).toHaveBeenCalledWith({
      content: '**👤 User One** · Ticket #101\nHier ist der Beweis',
      files: [{ attachment: proof.url, name: 'proof.png' }],
      allowedMentions: { parse: [] },
    });
    expect(react).toHaveBeenCalledWith('📨');
    expect(reply).toHaveBeenCalledWith({
      content: '↳ weitergeleitet · Ticket #101',
      allowedMentions: { parse: [] },
    });
  });

  it('relays attachment-only owner replies to exactly the ticket selected by Discord reply', async () => {
    const first = ticket();
    const second = ticket({
      id: 'ticket-202',
      ticketNumber: 202,
      userDiscordId: 'user-2',
      username: 'User Two',
      subject: 'Zweites Ticket',
    });
    mockTicketFindMany.mockResolvedValue([first, second]);
    const clip = attachment({
      id: '333333333333333333',
      name: 'clip.mp4',
      url: 'https://media.discordapp.net/ephemeral-attachments/111111111111111111/333333333333333333/clip.mp4?ex=999',
      size: 1024,
    });
    const { msg, fetchUser, targetSend } = dmMessage({
      authorId: 'owner-1',
      content: '',
      attachments: [clip],
      referenceMessageId: 'discord-message-202',
      referencedMessage: {
        content: '**👤 User Two** · Ticket #202\nVorherige Nachricht',
        embeds: [],
      },
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(fetchUser).toHaveBeenCalledTimes(1);
    expect(fetchUser).toHaveBeenCalledWith('user-2');
    expect(fetchUser).not.toHaveBeenCalledWith('user-1');
    expect(mockTicketMessageCreate).toHaveBeenCalledWith({
      data: {
        ticketId: 'ticket-202',
        fromDiscordId: 'owner-1',
        fromRole: 'OWNER',
        content: '',
      },
    });
    expect(targetSend).toHaveBeenCalledWith({
      content: '**🛡️ Owner** · Ticket #202\n',
      files: [{ attachment: clip.url, name: 'clip.mp4' }],
      allowedMentions: { parse: [] },
    });
  });

  it('fails closed for a non-Discord attachment URL instead of letting discord.js fetch it', async () => {
    mockTicketFindMany.mockResolvedValue([ticket()]);
    const { msg, targetSend, reply, react } = dmMessage({
      authorId: 'user-1',
      content: 'Unsicherer Anhang',
      attachments: [attachment({ url: 'https://example.com/attachments/111/222/proof.png' })],
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(targetSend).not.toHaveBeenCalled();
    expect(react).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply.mock.calls[0][0]).toEqual(expect.objectContaining({
      embeds: expect.any(Array),
      allowedMentions: { parse: [] },
    }));
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Ticket #101: Relay-DM an owner-1 fehlgeschlagen',
      expect.objectContaining({ e: expect.stringContaining('Discord-CDN-Host') }),
    );
    expect(mockLogAudit).toHaveBeenCalledWith('TICKET_RELAY_FAILED', 'TICKET', {
      ticketNumber: 101,
      fromRole: 'USER',
      targetId: 'owner-1',
    });
  });

  it('rejects attachments above the established 25 MiB Discord relay limit before upload', async () => {
    mockTicketFindMany.mockResolvedValue([ticket()]);
    const { msg, targetSend, reply } = dmMessage({
      authorId: 'user-1',
      content: 'Zu gross',
      attachments: [attachment({ size: 25 * 1024 * 1024 + 1 })],
    });

    await expect(handleTicketDm(msg)).resolves.toBe(true);

    expect(targetSend).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledTimes(1);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'Ticket #101: Relay-DM an owner-1 fehlgeschlagen',
      expect.objectContaining({ e: expect.stringContaining('groesser als 25 MiB') }),
    );
  });
});
