process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const GID = '999999999999999999';
const ROLE = '333333333333333301';

const findUnique = jest.fn();
const findFirst = jest.fn();
const modeMap = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    selfRoleMenu: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      findFirst: (...a: unknown[]) => findFirst(...a),
    },
  },
}));

jest.mock('../../src/modules/selfrole/optionAssignModeStore', () => ({
  __esModule: true,
  getOptionAssignModeMap: (...a: unknown[]) => modeMap(...a),
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAudit: jest.fn(),
}));

import {
  buildMenuRows,
  handleSelfRoleButton,
  handleSelfRoleReaction,
  handleSelfRoleSelect,
} from '../../src/modules/selfrole/selfRoleMenu';

function menuRow(componentType: 'BUTTON' | 'SELECT' | 'REACTION' = 'BUTTON', assignMode = 'REMOVE') {
  return {
    id: 'm1', guildId: GID, channelId: '222222222222222222', messageId: 'msg1', title: 'Menü',
    description: null, mode: 'MULTI', isActive: true, componentType,
    assignMode, maxRolesPerUser: null, archived: false, embedId: 'e1', embed: null,
    options: [{
      id: 'o1', roleId: ROLE, roleIds: [ROLE], label: 'VIP', emoji: '✅',
      description: null, confirmMessage: 'Hallo {username}', position: 0,
      buttonStyle: 'PRIMARY', isActive: true,
    }],
  };
}

function makeGuildMember(hasRole = false) {
  const ids = new Set<string>(hasRole ? [ROLE] : []);
  const role = { id: ROLE, name: 'VIP', position: 1, managed: false };
  const rolesCache = new Map<string, unknown>([[ROLE, role]]);
  const add = jest.fn(async (id: string) => { ids.add(id); });
  const remove = jest.fn(async (id: string) => { ids.delete(id); });
  const send = jest.fn().mockResolvedValue({});
  const guild = {
    id: GID,
    roles: { cache: rolesCache, fetch: async (id: string) => rolesCache.get(id) ?? null },
    members: { me: { roles: { highest: { position: 50 } }, permissions: { has: () => true } } },
    channels: { cache: new Map(), fetch: jest.fn().mockResolvedValue(null) },
  };
  const member = { id: 'u1', displayName: 'Tester', roles: { cache: ids, add, remove }, send };
  return { guild, member, add, remove, send };
}

beforeEach(() => {
  jest.clearAllMocks();
  modeMap.mockResolvedValue(new Map([['o1', 'GIVE']]));
  findUnique.mockResolvedValue(menuRow());
  findFirst.mockResolvedValue({ id: 'm1' });
});

describe('SelfRole pro Option', () => {
  it('ueberschreibt den universellen Menu-Modus pro Button', async () => {
    const { guild, member, add, remove } = makeGuildMember(false);
    const reply = jest.fn().mockResolvedValue({});
    await handleSelfRoleButton({ customId: 'selfrole_m1_o1', guild, member, reply } as never);

    expect(add).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(remove).not.toHaveBeenCalled();
    const response = reply.mock.calls[0][0] as { embeds: Array<{ data: { description?: string } }>; ephemeral: boolean };
    expect(response.ephemeral).toBe(true);
    expect(response.embeds[0].data.description).toContain('Hallo Tester');
    expect(response.embeds[0].data.description).toContain('erhalten');
  });

  it('baut Dropdowns als einzelne Aktion mit Placeholder', () => {
    const menu = menuRow('SELECT', 'TOGGLE');
    const rows = buildMenuRows({
      ...menu,
      options: menu.options.map(o => ({ ...o, assignMode: null })),
    } as never);
    const json = rows[0].toJSON();
    const select = json.components[0] as { placeholder?: string; min_values?: number; max_values?: number };
    expect(select.placeholder).toBe('Rollen auswählen…');
    expect(select.min_values).toBe(1);
    expect(select.max_values).toBe(1);
  });

  it('setzt das Dropdown nach Auswahl zurueck und antwortet mit Status-Embed', async () => {
    findUnique.mockResolvedValue(menuRow('SELECT'));
    const { guild, member, add } = makeGuildMember(false);
    const deferUpdate = jest.fn().mockResolvedValue({});
    const editReply = jest.fn().mockResolvedValue({});
    const followUp = jest.fn().mockResolvedValue({});
    const reply = jest.fn().mockResolvedValue({});

    await handleSelfRoleSelect({
      customId: 'selfrole_sel_m1', values: ['o1'], guild, member,
      deferUpdate, editReply, followUp, reply,
    } as never);

    expect(add).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(editReply).toHaveBeenCalledWith(expect.objectContaining({ components: expect.any(Array) }));
    const feedback = followUp.mock.calls[0][0] as { embeds?: unknown[]; ephemeral?: boolean };
    expect(feedback.ephemeral).toBe(true);
    expect(feedback.embeds).toHaveLength(1);
  });

  it('sendet bei Emoji-Reaktion dieselbe Embed-Rueckmeldung per DM', async () => {
    findUnique.mockResolvedValue(menuRow('REACTION'));
    const { guild, member, add, send } = makeGuildMember(false);

    const handled = await handleSelfRoleReaction(guild as never, 'msg1', '✅', null, member as never, true);

    expect(handled).toBe(true);
    expect(add).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(send).toHaveBeenCalledTimes(1);
    const dm = send.mock.calls[0][0] as { embeds?: unknown[] };
    expect(dm.embeds).toHaveLength(1);
  });
});
