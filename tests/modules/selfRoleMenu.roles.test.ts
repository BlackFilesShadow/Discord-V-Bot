process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

/**
 * Rollen-Button-Rueckmeldungen (Spezifikation):
 *  - GIVE, Rolle fehlt   -> vergeben + "✅ Du hast die Rolle „X“ erhalten."
 *  - GIVE, Rolle vorhanden -> keine Aktion + "ℹ️ Du besitzt die Rolle „X“ bereits."
 *  - REMOVE, Rolle vorhanden -> entfernen + "✅ Die Rolle „X“ wurde dir entfernt."
 *  - REMOVE, Rolle fehlt -> keine Aktion + "ℹ️ Du besitzt die Rolle „X“ nicht."
 *  - Antwort IMMER ephemer; die urspruengliche Nachricht wird NIE veraendert.
 */

const GID = '999999999999999999';
const ROLE = '333333333333333301';
const ROLE_NAME = 'VIP';

const findUnique = jest.fn();
jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: { selfRoleMenu: { findUnique: (...a: unknown[]) => findUnique(...a) } },
}));
jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
  logAudit: jest.fn(),
}));

import { handleSelfRoleButton } from '../../src/modules/selfrole/selfRoleMenu';

function menuRow(assignMode: 'GIVE' | 'REMOVE' | 'TOGGLE') {
  return {
    id: 'm1', guildId: GID, channelId: '1', messageId: 'msg1', title: 'Menü',
    description: null, mode: 'MULTI', isActive: true, componentType: 'BUTTON',
    assignMode, maxRolesPerUser: null, archived: false, embedId: 'e1', embed: null,
    options: [{
      id: 'o1', roleId: ROLE, roleIds: [ROLE], label: 'VIP-Button', emoji: null,
      description: null, confirmMessage: null, position: 0, buttonStyle: 'PRIMARY', isActive: true,
    }],
  };
}

function makeInteraction(hasRole: boolean) {
  const memberRoleIds = new Set<string>(hasRole ? [ROLE] : []);
  const role = { id: ROLE, name: ROLE_NAME, position: 1, managed: false };
  const rolesCache = new Map<string, unknown>([[ROLE, role]]);
  const add = jest.fn(async (id: string) => { memberRoleIds.add(id); });
  const remove = jest.fn(async (id: string) => { memberRoleIds.delete(id); });
  const guild = {
    id: GID,
    roles: { cache: rolesCache, fetch: async (id: string) => rolesCache.get(id) ?? null },
    members: { me: { roles: { highest: { position: 50 } }, permissions: { has: () => true } } },
  };
  const member = { id: 'u1', displayName: 'Tester', roles: { cache: memberRoleIds, add, remove } };
  const reply = jest.fn().mockResolvedValue({});
  const btn = { customId: 'selfrole_m1_o1', guild, member, reply };
  return { btn, add, remove, reply, memberRoleIds };
}

function replyDescription(reply: jest.Mock): string {
  const arg = reply.mock.calls[0][0] as { embeds: Array<{ data: { description?: string } }>; ephemeral?: boolean };
  expect(arg.ephemeral).toBe(true);
  return arg.embeds[0].data.description ?? '';
}

beforeEach(() => jest.clearAllMocks());

describe('handleSelfRoleButton — GIVE', () => {
  it('vergibt die Rolle und bestaetigt, wenn sie fehlt', async () => {
    findUnique.mockResolvedValue(menuRow('GIVE'));
    const { btn, add, reply } = makeInteraction(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleSelfRoleButton(btn as any);
    expect(add).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(replyDescription(reply)).toContain(`Du hast die Rolle „${ROLE_NAME}“ erhalten.`);
  });

  it('informiert ohne Aktion, wenn die Rolle bereits vorhanden ist', async () => {
    findUnique.mockResolvedValue(menuRow('GIVE'));
    const { btn, add, remove, reply } = makeInteraction(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleSelfRoleButton(btn as any);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replyDescription(reply)).toContain(`Du besitzt die Rolle „${ROLE_NAME}“ bereits.`);
  });
});

describe('handleSelfRoleButton — REMOVE', () => {
  it('entfernt die Rolle und bestaetigt, wenn sie vorhanden ist', async () => {
    findUnique.mockResolvedValue(menuRow('REMOVE'));
    const { btn, remove, reply } = makeInteraction(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleSelfRoleButton(btn as any);
    expect(remove).toHaveBeenCalledWith(ROLE, expect.any(String));
    expect(replyDescription(reply)).toContain(`Die Rolle „${ROLE_NAME}“ wurde dir entfernt.`);
  });

  it('informiert ohne Aktion, wenn die Rolle nicht vorhanden ist', async () => {
    findUnique.mockResolvedValue(menuRow('REMOVE'));
    const { btn, add, remove, reply } = makeInteraction(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await handleSelfRoleButton(btn as any);
    expect(add).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(replyDescription(reply)).toContain(`Du besitzt die Rolle „${ROLE_NAME}“ nicht.`);
  });
});
