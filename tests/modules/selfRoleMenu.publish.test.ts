// Minimal nötige ENV-Variablen für config.ts (defensiv).
process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * publishMenu-Entkopplung (Reaktions-Embeds):
 *  - Ist eine Einbettung verknuepft, werden die Button-Components an die
 *    BESTEHENDE Embed-Nachricht angehaengt (message.edit NUR components).
 *  - Es wird NIE eine neue Nachricht gesendet (channel.send bleibt ungenutzt).
 *  - Der Embed-Inhalt (embeds/content) wird beim Edit nicht angefasst.
 */

const GID = '999999999999999999';
const CH = '222222222222222222';
const EMB_MSG = 'embmsg-1';
const ROLE = '333333333333333301';

const dashboardEmbedFindUnique = jest.fn();
const selfRoleMenuUpdate = jest.fn().mockResolvedValue({});
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    dashboardEmbed: { findUnique: (...a: unknown[]) => dashboardEmbedFindUnique(...a) },
    selfRoleMenu: { update: (...a: unknown[]) => selfRoleMenuUpdate(...a) },
  },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAudit: jest.fn(),
}));

import { publishMenu } from '../../src/modules/selfrole/selfRoleMenu';

interface MenuLike { [k: string]: unknown }

function baseMenu(overrides: MenuLike = {}): MenuLike {
  return {
    id: 'm1', guildId: GID, channelId: CH, messageId: EMB_MSG,
    title: 'Rollen', description: null, mode: 'MULTI', isActive: true,
    componentType: 'BUTTON', assignMode: 'TOGGLE', maxRolesPerUser: null,
    archived: false, embedId: 'emb-1', embed: null,
    options: [{
      id: 'o1', roleId: ROLE, roleIds: [ROLE], label: 'Klick mich', emoji: null,
      description: null, confirmMessage: null, position: 0, buttonStyle: 'PRIMARY', isActive: true,
    }],
    ...overrides,
  };
}

function makeChannelWithMessage() {
  const edit = jest.fn().mockResolvedValue({});
  const react = jest.fn().mockResolvedValue({});
  const message = { id: EMB_MSG, edit, react };
  const send = jest.fn().mockResolvedValue({ id: 'new-msg' });
  const channel = {
    id: CH,
    isTextBased: () => true,
    isDMBased: () => false,
    guild: { channels: { fetch: jest.fn() } },
    messages: { fetch: jest.fn().mockResolvedValue(message) },
    send,
  };
  return { channel, message, edit, send, react };
}

beforeEach(() => {
  jest.clearAllMocks();
  dashboardEmbedFindUnique.mockResolvedValue({ channelId: CH, messageId: EMB_MSG });
});

describe('publishMenu — verknuepfte Einbettung (entkoppelt)', () => {
  it('editiert NUR components und sendet KEINE neue Nachricht', async () => {
    const { channel, edit, send } = makeChannelWithMessage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = await publishMenu(baseMenu() as any, channel as any);

    expect(id).toBe(EMB_MSG);
    expect(send).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledTimes(1);
    const arg = edit.mock.calls[0][0] as Record<string, unknown>;
    expect(arg).toHaveProperty('components');
    // Embed-Inhalt darf NICHT angefasst werden.
    expect(arg).not.toHaveProperty('embeds');
    expect(arg).not.toHaveProperty('content');
  });

  it('lehnt ab, wenn die verknuepfte Einbettung noch nicht gesendet wurde', async () => {
    dashboardEmbedFindUnique.mockResolvedValue({ channelId: null, messageId: null });
    const { channel, send } = makeChannelWithMessage();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(publishMenu(baseMenu() as any, channel as any)).rejects.toThrow(/noch nicht/i);
    expect(send).not.toHaveBeenCalled();
  });

  it('setzt bei REACTION-Menus Emojis auf die bestehende Nachricht', async () => {
    const { channel, react, send } = makeChannelWithMessage();
    const menu = baseMenu({
      componentType: 'REACTION',
      options: [{
        id: 'o1', roleId: ROLE, roleIds: [ROLE], label: 'R', emoji: '🎮',
        description: null, confirmMessage: null, position: 0, buttonStyle: 'SECONDARY', isActive: true,
      }],
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await publishMenu(menu as any, channel as any);
    expect(react).toHaveBeenCalledWith('🎮');
    expect(send).not.toHaveBeenCalled();
  });
});
