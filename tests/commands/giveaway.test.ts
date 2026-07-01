/**
 * Regressionstest: manuelles Giveaway-Ende (/giveaway end) haerten.
 *
 * Sicherheitsfokus: nutzerkontrollierter `prize`-Text darf ueber die
 * Ende-Nachrichten kein @everyone / fremde Rollen pingen. Alle Ausgaben
 * muessen `allowedMentions` strikt auf echte Gewinner + notifyRole begrenzen.
 */

// Prisma + Giveaway-Manager mocken, bevor der Command importiert wird.
const prismaMock = {
  giveaway: { findFirst: jest.fn() },
  user: { findUnique: jest.fn() },
};
jest.mock('../../src/database/prisma', () => ({ __esModule: true, default: prismaMock }));

const drawWinnersMock = jest.fn();
jest.mock('../../src/modules/giveaway/giveawayManager', () => ({
  __esModule: true,
  drawWinners: (...a: unknown[]) => drawWinnersMock(...a),
  // vom Command ebenfalls importiert (nur Typen/keine Nutzung im Test-Pfad):
  createGiveaway: jest.fn(),
  enterGiveaway: jest.fn(),
  getGiveaway: jest.fn(),
  listActiveGiveaways: jest.fn(),
}));

import { handleEnd } from '../../src/commands/user/giveaway';

interface Captured { content?: string; allowedMentions?: unknown }

function makeInteraction(overrides?: { channelSend?: jest.Mock }) {
  const editReply = jest.fn().mockResolvedValue({});
  const channelSend = overrides?.channelSend ?? jest.fn().mockResolvedValue({});
  const interaction = {
    guildId: '999999999999999999',
    user: { id: '111111111111111111' },
    deferReply: jest.fn().mockResolvedValue({}),
    editReply,
    options: { getString: jest.fn().mockReturnValue('gw-1') },
    channel: { send: channelSend },
  };
  return { interaction, editReply, channelSend };
}

const EVERYONE_PRIZE = '@everyone GRATIS NITRO <@&222222222222222222>';

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.user.findUnique.mockResolvedValue({ role: 'ADMIN' });
});

describe('/giveaway end — Mentions-Haertung', () => {
  it('Gewinner-Ende: editReply + channel.send begrenzen allowedMentions strikt', async () => {
    prismaMock.giveaway.findFirst.mockResolvedValue({
      id: 'gw-1', prize: EVERYONE_PRIZE, notifyRoleId: '333333333333333333',
      creator: { discordId: '111111111111111111' },
    });
    drawWinnersMock.mockResolvedValue({ success: true, winners: [{ discordId: '444444444444444444' }] });

    const { interaction, editReply, channelSend } = makeInteraction();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEnd(interaction as any);

    const reply = editReply.mock.calls[0][0] as Captured;
    expect(reply.allowedMentions).toEqual({ users: ['444444444444444444'], parse: [] });

    const sent = channelSend.mock.calls[0][0] as Captured;
    expect(sent.allowedMentions).toEqual({ users: ['444444444444444444'], roles: ['333333333333333333'] });
    // Der prize-Text (mit @everyone) ist zwar im content, wird aber durch
    // allowedMentions ohne 'everyone' niemals aufgeloest.
    expect(JSON.stringify(sent.allowedMentions)).not.toMatch(/everyone/);
  });

  it('Kein-Gewinner-Ende: begrenzt allowedMentions ebenfalls (kein everyone)', async () => {
    prismaMock.giveaway.findFirst.mockResolvedValue({
      id: 'gw-1', prize: EVERYONE_PRIZE, notifyRoleId: '333333333333333333',
      creator: { discordId: '111111111111111111' },
    });
    drawWinnersMock.mockResolvedValue({ success: true, winners: [], message: 'Keine Teilnehmer.' });

    const { interaction, editReply, channelSend } = makeInteraction();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEnd(interaction as any);

    const reply = editReply.mock.calls[0][0] as Captured;
    expect(reply.allowedMentions).toEqual({ parse: [] });

    const sent = channelSend.mock.calls[0][0] as Captured;
    expect(sent.allowedMentions).toEqual({ roles: ['333333333333333333'], parse: [] });
  });

  it('ohne notifyRole wird keine Channel-Nachricht gesendet', async () => {
    prismaMock.giveaway.findFirst.mockResolvedValue({
      id: 'gw-1', prize: 'Ehrliche Belohnung', notifyRoleId: null,
      creator: { discordId: '111111111111111111' },
    });
    drawWinnersMock.mockResolvedValue({ success: true, winners: [{ discordId: '444444444444444444' }] });

    const { interaction, channelSend } = makeInteraction();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleEnd(interaction as any);

    expect(channelSend).not.toHaveBeenCalled();
  });
});
