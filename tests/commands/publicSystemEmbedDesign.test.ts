import { MessageFlags } from 'discord.js';

const mockTicketFindMany = jest.fn();
const mockTicketFindFirst = jest.fn();
const mockCreateTicket = jest.fn();
const mockCloseTicket = jest.fn();

jest.mock('../../src/content/botInfo', () => ({
  BOT_PRODUCT_NAME: 'V-Bot Prime',
  buildBotAboutText: () => 'Feature A\nFeature B',
}));

jest.mock('../../src/modules/ticket/ticketManager', () => ({
  createTicket: mockCreateTicket,
  closeTicket: mockCloseTicket,
}));

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    ticket: {
      findMany: mockTicketFindMany,
      findFirst: mockTicketFindFirst,
    },
  },
}));

import aboutCommand from '../../src/commands/about';
import ticketCommand from '../../src/commands/user/ticket';

describe('public V-Bot system embed design', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders /stell-dich-vor as a compact public system embed', async () => {
    const reply = jest.fn().mockResolvedValue(undefined);

    await aboutCommand.execute({ reply } as any);

    expect(reply).toHaveBeenCalledTimes(1);
    const payload = reply.mock.calls[0][0];
    expect(payload.ephemeral).toBe(false);
    const json = payload.embeds[0].toJSON();
    expect(json.title).toBeUndefined();
    expect(json.description).toBe('**🤖 V-Bot Prime — aktueller Funktionsstand**\nFeature A\nFeature B');
    expect(json.footer?.text).toBe('V-Bot Prime • Live-Funktionsuebersicht');
    expect(json.timestamp).toBeUndefined();
  });

  it('keeps /ticket status ephemeral while using the compact list presentation', async () => {
    mockTicketFindMany.mockResolvedValueOnce([{
      ticketNumber: 7,
      status: 'OPEN',
      subject: 'Testanfrage',
      createdAt: new Date('2026-09-11T18:00:00.000Z'),
    }]);
    const deferReply = jest.fn().mockResolvedValue(undefined);
    const editReply = jest.fn().mockResolvedValue(undefined);

    await ticketCommand.execute({
      options: { getSubcommand: () => 'status' },
      deferReply,
      editReply,
      user: { id: '123' },
      guildId: '456',
    } as any);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    const payload = editReply.mock.calls[0][0];
    const json = payload.embeds[0].toJSON();
    expect(json.title).toBeUndefined();
    expect(json.description).toContain('**🎟️ Deine Tickets**');
    expect(json.description).toContain('**#7** · `OPEN` · Testanfrage');
    expect(json.footer?.text).toBe('V-Bot Prime');
  });

  it('keeps /ticket open semantics while rendering the result as a compact status embed', async () => {
    mockCreateTicket.mockResolvedValueOnce({ success: true, ticketNumber: 42, message: 'Anfrage wurde erstellt.' });
    const deferReply = jest.fn().mockResolvedValue(undefined);
    const editReply = jest.fn().mockResolvedValue(undefined);

    await ticketCommand.execute({
      options: {
        getSubcommand: () => 'open',
        getString: (name: string) => name === 'betreff' ? 'Betreff' : 'Nachricht',
      },
      deferReply,
      editReply,
      client: {},
      user: { id: '123', username: 'Tester' },
      guildId: '456',
      guild: { name: 'Testserver' },
    } as any);

    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(mockCreateTicket).toHaveBeenCalledWith(expect.objectContaining({
      userDiscordId: '123',
      username: 'Tester',
      guildId: '456',
      subject: 'Betreff',
      initialMessage: 'Nachricht',
    }));
    const payload = editReply.mock.calls[0][0];
    const json = payload.embeds[0].toJSON();
    expect(json.title).toBeUndefined();
    expect(json.description).toBe('**✅ 📨 Ticket #42 erstellt**\nAnfrage wurde erstellt.');
    expect(json.footer?.text).toBe('V-Bot Prime');
  });
});
