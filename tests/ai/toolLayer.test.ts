import { z } from 'zod';
import {
  AiToolExecutor,
  digestAiToolArguments,
  type AiToolAuthorizationRequest,
  type AiToolStepUpBinding,
} from '../../src/modules/ai/toolLayer';
import {
  asGuildId,
  asNitradoConnId,
  asUserDiscordId,
  type GuildScope,
  type PermissionScope,
} from '../../src/types/scope';

const guildId = '123456789012345678';
const actorDiscordId = '234567890123456789';
const otherActor = '345678901234567890';
const nitradoConnId = 'c123456789012345678901234';
const otherConnId = 'c987654321098765432109876';

function scope(overrides: Partial<GuildScope> = {}): GuildScope {
  return {
    guildId: asGuildId(guildId),
    nitradoConnId: asNitradoConnId(nitradoConnId),
    actorDiscordId: asUserDiscordId(actorDiscordId),
    isOwner: false,
    permissions: new Set<PermissionScope>(['nitrado.view', 'nitrado.write', 'nitrado.danger']),
    ...overrides,
  };
}

describe('AI-18 tool execution boundary', () => {
  test('READ_ONLY tool executes only after schema + current authorization + exact gameserver scope', async () => {
    const authorize = jest.fn(async (_request: AiToolAuthorizationRequest) => scope());
    const handler = jest.fn(async (input: { detail: boolean }) => ({ ok: true, detail: input.detail }));
    const executor = new AiToolExecutor(authorize);
    executor.register({
      name: 'nitrado.status',
      description: 'Read status',
      risk: 'READ_ONLY',
      scope: 'GAMESERVER',
      permission: 'nitrado.view',
      inputSchema: z.object({ detail: z.boolean() }).strict(),
      execute: handler,
    });

    await expect(executor.execute(
      { name: 'nitrado.status', arguments: { detail: true } },
      { actorDiscordId, guildId, nitradoConnId },
    )).resolves.toEqual({ ok: true, detail: true });

    expect(authorize).toHaveBeenCalledWith({
      actorDiscordId,
      guildId,
      nitradoConnId,
      permission: 'nitrado.view',
      toolName: 'nitrado.status',
      scopeKind: 'GAMESERVER',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('model cannot inject trusted actor/guild/gameserver/auth fields even with a permissive schema', async () => {
    const handler = jest.fn();
    const executor = new AiToolExecutor(async () => scope());
    executor.register({
      name: 'nitrado.status',
      description: 'Read status',
      risk: 'READ_ONLY',
      scope: 'GAMESERVER',
      permission: 'nitrado.view',
      inputSchema: z.record(z.unknown()),
      execute: handler,
    });

    await expect(executor.execute(
      { name: 'nitrado.status', arguments: { nested: { guildId: '999999999999999999' } } },
      { actorDiscordId, guildId, nitradoConnId },
    )).rejects.toMatchObject({ code: 'UNTRUSTED_SCOPE_FIELD' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('unknown tool and invalid schema fail closed before authorization or handler execution', async () => {
    const authorize = jest.fn(async () => scope());
    const handler = jest.fn();
    const executor = new AiToolExecutor(authorize);
    executor.register({
      name: 'nitrado.status',
      description: 'Read status',
      risk: 'READ_ONLY',
      scope: 'GAMESERVER',
      permission: 'nitrado.view',
      inputSchema: z.object({ detail: z.boolean() }).strict(),
      execute: handler,
    });

    await expect(executor.execute(
      { name: 'nitrado.unknown', arguments: {} },
      { actorDiscordId, guildId, nitradoConnId },
    )).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });

    await expect(executor.execute(
      { name: 'nitrado.status', arguments: { detail: 'yes' } },
      { actorDiscordId, guildId, nitradoConnId },
    )).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });

    expect(authorize).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test('cross-user and cross-gameserver authorization results fail closed', async () => {
    const handler = jest.fn();
    const actorMismatch = new AiToolExecutor(async () => scope({ actorDiscordId: asUserDiscordId(otherActor) }));
    actorMismatch.register({
      name: 'nitrado.status', description: 'Read', risk: 'READ_ONLY', scope: 'GAMESERVER',
      permission: 'nitrado.view', inputSchema: z.object({}).strict(), execute: handler,
    });
    await expect(actorMismatch.execute(
      { name: 'nitrado.status', arguments: {} },
      { actorDiscordId, guildId, nitradoConnId },
    )).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });

    const serverMismatch = new AiToolExecutor(async () => scope({ nitradoConnId: asNitradoConnId(otherConnId) }));
    serverMismatch.register({
      name: 'nitrado.status', description: 'Read', risk: 'READ_ONLY', scope: 'GAMESERVER',
      permission: 'nitrado.view', inputSchema: z.object({}).strict(), execute: handler,
    });
    await expect(serverMismatch.execute(
      { name: 'nitrado.status', arguments: {} },
      { actorDiscordId, guildId, nitradoConnId },
    )).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });

    expect(handler).not.toHaveBeenCalled();
  });

  test('dashboard.access never becomes an AI/command privilege bypass', async () => {
    const handler = jest.fn();
    const executor = new AiToolExecutor(async () => scope({
      permissions: new Set<PermissionScope>(['dashboard.access']),
    }));
    executor.register({
      name: 'nitrado.restart', description: 'Restart', risk: 'MUTATING', scope: 'GAMESERVER',
      permission: 'nitrado.write', inputSchema: z.object({ reason: z.string().min(3) }).strict(), execute: handler,
    });

    await expect(executor.execute(
      { name: 'nitrado.restart', arguments: { reason: 'maintenance' } },
      { actorDiscordId, guildId, nitradoConnId, stepUpToken: 'opaque' },
    )).rejects.toMatchObject({ code: 'AUTHORIZATION_DENIED' });
    expect(handler).not.toHaveBeenCalled();
  });

  test.each(['MUTATING', 'DESTRUCTIVE'] as const)('%s tool requires step-up and never reaches handler without it', async (risk) => {
    const handler = jest.fn();
    const executor = new AiToolExecutor(async () => scope());
    executor.register({
      name: risk === 'MUTATING' ? 'nitrado.restart' : 'nitrado.factory-reset',
      description: 'Dangerous action',
      risk,
      scope: 'GAMESERVER',
      permission: risk === 'MUTATING' ? 'nitrado.write' : 'nitrado.danger',
      inputSchema: z.object({ reason: z.string().min(3) }).strict(),
      execute: handler,
    });

    await expect(executor.execute(
      { name: risk === 'MUTATING' ? 'nitrado.restart' : 'nitrado.factory-reset', arguments: { reason: 'maintenance' } },
      { actorDiscordId, guildId, nitradoConnId },
    )).rejects.toMatchObject({ code: 'STEP_UP_REQUIRED' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('step-up is bound to exact parsed arguments and consumed by trusted verifier before mutation', async () => {
    const handler = jest.fn(async () => 'done');
    const expectedArgs = { reason: 'maintenance', delaySeconds: 5 };
    const verifier = {
      verifyAndConsume: jest.fn(async (token: string, binding: AiToolStepUpBinding) => (
        token === 'trusted-one-shot-token'
        && binding.actorDiscordId === actorDiscordId
        && binding.guildId === guildId
        && binding.nitradoConnId === nitradoConnId
        && binding.toolName === 'nitrado.restart'
        && binding.argumentsDigest === digestAiToolArguments(expectedArgs)
      )),
    };
    const executor = new AiToolExecutor(async () => scope(), verifier);
    executor.register({
      name: 'nitrado.restart', description: 'Restart', risk: 'MUTATING', scope: 'GAMESERVER',
      permission: 'nitrado.write',
      inputSchema: z.object({ reason: z.string().min(3), delaySeconds: z.number().int().min(0).max(60) }).strict(),
      execute: handler,
    });

    await expect(executor.execute(
      { name: 'nitrado.restart', arguments: { delaySeconds: 5, reason: 'maintenance' } },
      { actorDiscordId, guildId, nitradoConnId, stepUpToken: 'trusted-one-shot-token' },
    )).resolves.toBe('done');
    expect(verifier.verifyAndConsume).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('invalid or mismatched step-up fails closed before mutation', async () => {
    const handler = jest.fn();
    const executor = new AiToolExecutor(async () => scope(), { verifyAndConsume: async () => false });
    executor.register({
      name: 'nitrado.restart', description: 'Restart', risk: 'MUTATING', scope: 'GAMESERVER',
      permission: 'nitrado.write', inputSchema: z.object({ reason: z.string() }).strict(), execute: handler,
    });

    await expect(executor.execute(
      { name: 'nitrado.restart', arguments: { reason: 'maintenance' } },
      { actorDiscordId, guildId, nitradoConnId, stepUpToken: 'wrong' },
    )).rejects.toMatchObject({ code: 'STEP_UP_INVALID' });
    expect(handler).not.toHaveBeenCalled();
  });

  test('argument digest is deterministic across JSON object key order', () => {
    expect(digestAiToolArguments({ b: 2, nested: { z: true, a: 'x' }, a: 1 }))
      .toBe(digestAiToolArguments({ a: 1, nested: { a: 'x', z: true }, b: 2 }));
  });
});
