import {
  authorizeAiToolRequest,
  executeProductionAiTool,
  getProductionAiToolExecutor,
  listProductionAiToolNames,
  resetProductionAiToolRuntimeForTests,
} from '../../src/modules/ai/toolRuntime';
import { setDashboardClient } from '../../src/dashboard/clientRegistry';
import * as repository from '../../src/modules/nitrado/repository';
import * as access from '../../src/modules/permissions/access';
import { asGuildId, asNitradoConnId, asUserDiscordId } from '../../src/types/scope';

jest.mock('../../src/modules/nitrado/repository', () => ({
  getById: jest.fn(),
}));

jest.mock('../../src/modules/permissions/access', () => ({
  resolveDelegatedPermissionContext: jest.fn(),
}));

const guildId = '123456789012345678';
const actorId = '234567890123456789';
const ownerId = actorId;
const otherUser = '345678901234567890';
const connId = 'c123456789012345678901234';
const otherConn = 'c987654321098765432109876';

function mockDiscordClient(opts: { ownerId: string; memberIds?: string[] }) {
  const members = new Map<string, { id: string; joinedAt: Date; roles: { cache: Map<string, unknown> } }>();
  for (const id of opts.memberIds ?? [opts.ownerId]) {
    members.set(id, {
      id,
      joinedAt: new Date('2020-01-01T00:00:00.000Z'),
      roles: { cache: new Map() },
    });
  }
  const guild = {
    id: guildId,
    ownerId: opts.ownerId,
    members: {
      cache: {
        get: (id: string) => members.get(id) ?? null,
      },
      fetch: async (id: string) => members.get(id) ?? null,
    },
  };
  const client = {
    guilds: {
      cache: {
        get: (id: string) => (id === guildId ? guild : undefined),
      },
      fetch: async (id: string) => (id === guildId ? guild : null),
    },
    commands: undefined,
  };
  setDashboardClient(client as never);
  return guild;
}

describe('AI-18 production tool runtime', () => {
  beforeEach(() => {
    resetProductionAiToolRuntimeForTests();
    jest.clearAllMocks();
    process.env.AI_TOOL_STEP_UP_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef';
    mockDiscordClient({ ownerId, memberIds: [ownerId, otherUser] });
    (repository.getById as jest.Mock).mockImplementation(async (g: string, id: string) => {
      if (g !== guildId) return null;
      if (id !== connId) return null;
      return {
        id: connId,
        guildId,
        slot: 1,
        status: 'ACTIVE',
        alias: 'alpha',
        nitradoServerId: 'svc-1',
      };
    });
    (access.resolveDelegatedPermissionContext as jest.Mock).mockResolvedValue({
      member: { id: otherUser },
      permissions: new Set(['nitrado.view', 'dashboard.view']),
    });
  });

  test('production registry is fail-closed for destructive tools', () => {
    const names = listProductionAiToolNames();
    expect(names).toEqual(['ai.tools.catalog', 'nitrado.connection.status']);
    const risks = getProductionAiToolExecutor().describe().map(t => t.risk);
    expect(risks.every(r => r === 'READ_ONLY')).toBe(true);
  });

  test('allowed owner can read nitrado.connection.status', async () => {
    const result = await executeProductionAiTool({
      invocation: { name: 'nitrado.connection.status', arguments: { includeAlias: true } },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: connId },
    });
    expect(result).toMatchObject({
      ok: true,
      toolName: 'nitrado.connection.status',
      idempotentReplay: false,
      result: {
        guildId,
        nitradoConnId: connId,
        slot: 1,
        status: 'ACTIVE',
        alias: 'alpha',
        hasServerId: true,
      },
    });
  });

  test('unknown tool fails closed', async () => {
    const result = await executeProductionAiTool({
      invocation: { name: 'nitrado.restart', arguments: { reason: 'x' } },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: connId },
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'UNKNOWN_TOOL' }));
  });

  test('missing gameserver scope fails closed', async () => {
    const result = await executeProductionAiTool({
      invocation: { name: 'nitrado.connection.status', arguments: {} },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: null },
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'INVALID_SCOPE' }));
  });

  test('wrong gameserver id fails authorization', async () => {
    const result = await executeProductionAiTool({
      invocation: { name: 'nitrado.connection.status', arguments: {} },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: otherConn },
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'AUTHORIZATION_DENIED' }));
  });

  test('invalid arguments fail before domain', async () => {
    const result = await executeProductionAiTool({
      invocation: { name: 'nitrado.connection.status', arguments: { includeAlias: 'yes' } },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: connId },
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'INVALID_ARGUMENTS' }));
  });

  test('model cannot inject reserved scope fields', async () => {
    const result = await executeProductionAiTool({
      invocation: {
        name: 'nitrado.connection.status',
        arguments: { includeAlias: true, guildId: '999999999999999999' },
      },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: connId },
    });
    expect(result).toEqual(expect.objectContaining({ ok: false, code: 'UNTRUSTED_SCOPE_FIELD' }));
  });

  test('non-member fails closed via authorizer', async () => {
    (access.resolveDelegatedPermissionContext as jest.Mock).mockResolvedValue({
      member: null,
      permissions: new Set(),
    });
    mockDiscordClient({ ownerId: '999999999999999999', memberIds: [] });
    const denied = await authorizeAiToolRequest({
      actorDiscordId: otherUser,
      guildId,
      nitradoConnId: connId,
      permission: 'nitrado.view',
      toolName: 'nitrado.connection.status',
      scopeKind: 'GAMESERVER',
    });
    expect(denied).toBeNull();
  });

  test('idempotent replay returns cached result for same key', async () => {
    const req = {
      invocation: { name: 'nitrado.connection.status', arguments: { includeAlias: true } },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: connId },
      idempotencyKey: 'req-1',
    };
    const first = await executeProductionAiTool(req);
    const second = await executeProductionAiTool(req);
    expect(first).toMatchObject({ ok: true, idempotentReplay: false });
    expect(second).toMatchObject({ ok: true, idempotentReplay: true });
    expect(repository.getById).toHaveBeenCalledTimes(2); // auth + handler once; replay skips handler path after cache
    // first call: authorize getById + handler getById = 2; second: authorize may still run... actually cache hits before execute
    // So second should not call getById again if cache hits first.
    // Wait - authorize is inside execute, cache is before execute. So second call should be 2 total.
    expect(repository.getById).toHaveBeenCalledTimes(2);
  });

  test('catalog tool is guild-scoped and does not accept smuggled conn id', async () => {
    const smuggled = await executeProductionAiTool({
      invocation: { name: 'ai.tools.catalog', arguments: {} },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: connId },
    });
    // Authorizer rejects guild tools with nitradoConnId set
    expect(smuggled).toEqual(expect.objectContaining({ ok: false, code: 'AUTHORIZATION_DENIED' }));

    const ok = await executeProductionAiTool({
      invocation: { name: 'ai.tools.catalog', arguments: {} },
      context: { actorDiscordId: actorId, guildId, nitradoConnId: null },
    });
    expect(ok).toMatchObject({ ok: true, toolName: 'ai.tools.catalog' });
    if (ok.ok) {
      expect(Array.isArray((ok.result as { tools: unknown[] }).tools)).toBe(true);
    }
  });

  test('branded scope helpers remain consistent', () => {
    expect(asGuildId(guildId)).toBe(guildId);
    expect(asUserDiscordId(actorId)).toBe(actorId);
    expect(asNitradoConnId(connId)).toBe(connId);
  });
});
