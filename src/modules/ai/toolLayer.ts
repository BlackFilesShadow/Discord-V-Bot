import crypto from 'node:crypto';
import { z } from 'zod';
import {
  asGuildId,
  asNitradoConnId,
  asUserDiscordId,
  hasCommandPermission,
  type GuildScope,
  type PermissionScope,
} from '../../types/scope';

export type AiToolRisk = 'READ_ONLY' | 'MUTATING' | 'DESTRUCTIVE';
export type AiToolScopeKind = 'GUILD' | 'GAMESERVER';

export interface AiToolInvocation {
  name: string;
  arguments: unknown;
}

export interface AiToolExecutionContext {
  actorDiscordId: string;
  guildId: string;
  nitradoConnId?: string | null;
  /**
   * Opaque token from a trusted user-confirmation/reauth flow. This value is
   * application context and MUST NOT be sourced from model output.
   */
  stepUpToken?: string | null;
}

export interface AiToolAuthorizationRequest {
  actorDiscordId: string;
  guildId: string;
  nitradoConnId: string | null;
  permission: PermissionScope;
  toolName: string;
  scopeKind: AiToolScopeKind;
}

export type AiToolAuthorizer = (
  request: AiToolAuthorizationRequest,
) => Promise<GuildScope | null> | GuildScope | null;

export interface AiToolStepUpBinding {
  actorDiscordId: string;
  guildId: string;
  nitradoConnId: string | null;
  toolName: string;
  argumentsDigest: string;
}

export interface AiToolStepUpVerifier {
  verifyAndConsume(token: string, binding: AiToolStepUpBinding): Promise<boolean> | boolean;
}

export interface TrustedAiToolContext {
  scope: GuildScope;
  actorDiscordId: string;
  guildId: string;
  nitradoConnId: string | null;
  toolName: string;
}

export interface AiToolDefinition<TInput = unknown, TResult = unknown> {
  name: string;
  description: string;
  risk: AiToolRisk;
  scope: AiToolScopeKind;
  permission: PermissionScope;
  inputSchema: z.ZodType<TInput>;
  execute: (input: TInput, context: TrustedAiToolContext) => Promise<TResult> | TResult;
}

export type AiToolErrorCode =
  | 'INVALID_INVOCATION'
  | 'UNKNOWN_TOOL'
  | 'UNTRUSTED_SCOPE_FIELD'
  | 'INVALID_ARGUMENTS'
  | 'INVALID_SCOPE'
  | 'AUTHORIZATION_DENIED'
  | 'STEP_UP_REQUIRED'
  | 'STEP_UP_INVALID';

export class AiToolExecutionError extends Error {
  constructor(public readonly code: AiToolErrorCode, message: string) {
    super(message);
    this.name = 'AiToolExecutionError';
  }
}

const TOOL_NAME_RE = /^[a-z][a-z0-9_.-]{2,79}$/;
const RESERVED_MODEL_KEYS = new Set([
  'actorDiscordId',
  'guildId',
  'nitradoConnId',
  'isOwner',
  'permissions',
  'stepUpToken',
  'authorization',
  'auth',
]);

function assertNoReservedModelFields(value: unknown, depth = 0): void {
  if (depth > 20) {
    throw new AiToolExecutionError('INVALID_ARGUMENTS', 'Tool arguments are nested too deeply.');
  }
  if (Array.isArray(value)) {
    for (const item of value) assertNoReservedModelFields(item, depth + 1);
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (RESERVED_MODEL_KEYS.has(key)) {
      throw new AiToolExecutionError(
        'UNTRUSTED_SCOPE_FIELD',
        `Model-provided security/scope field is forbidden: ${key}`,
      );
    }
    assertNoReservedModelFields(child, depth + 1);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function digestAiToolArguments(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parseTrustedContext(
  definition: AiToolDefinition,
  context: AiToolExecutionContext,
): { actorDiscordId: ReturnType<typeof asUserDiscordId>; guildId: ReturnType<typeof asGuildId>; nitradoConnId: ReturnType<typeof asNitradoConnId> | null } {
  try {
    const actorDiscordId = asUserDiscordId(String(context.actorDiscordId || '').trim());
    const guildId = asGuildId(String(context.guildId || '').trim());
    const rawConn = String(context.nitradoConnId || '').trim();
    const nitradoConnId = rawConn ? asNitradoConnId(rawConn) : null;
    if (definition.scope === 'GAMESERVER' && !nitradoConnId) {
      throw new Error('Gameserver scope requires nitradoConnId.');
    }
    return { actorDiscordId, guildId, nitradoConnId };
  } catch {
    throw new AiToolExecutionError('INVALID_SCOPE', 'Trusted AI tool scope is missing or invalid.');
  }
}

/**
 * AI-18 security boundary between model output and application side effects.
 *
 * The model can only propose `{ name, arguments }`. Actor identity, Guild,
 * Gameserver, authorization and step-up proof are trusted application context.
 * Every execution revalidates exact scope + command permission. MUTATING and
 * DESTRUCTIVE tools additionally require a one-shot step-up verifier.
 *
 * This module intentionally imports no Prisma/Nitrado/Discord/Economy mutation
 * service. Concrete handlers must be registered by a trusted integration layer.
 */
export class AiToolExecutor {
  private readonly tools = new Map<string, AiToolDefinition>();

  constructor(
    private readonly authorize: AiToolAuthorizer,
    private readonly stepUpVerifier?: AiToolStepUpVerifier,
  ) {}

  register<TInput, TResult>(definition: AiToolDefinition<TInput, TResult>): void {
    const name = String(definition.name || '').trim();
    if (!TOOL_NAME_RE.test(name)) throw new Error(`Invalid AI tool name: ${name}`);
    if (this.tools.has(name)) throw new Error(`Duplicate AI tool: ${name}`);
    this.tools.set(name, definition as AiToolDefinition);
  }

  describe(): ReadonlyArray<Pick<AiToolDefinition, 'name' | 'description' | 'risk' | 'scope' | 'permission'>> {
    return Array.from(this.tools.values()).map(({ name, description, risk, scope, permission }) => ({
      name,
      description,
      risk,
      scope,
      permission,
    }));
  }

  async execute<TResult = unknown>(
    invocation: AiToolInvocation,
    context: AiToolExecutionContext,
  ): Promise<TResult> {
    if (!invocation || typeof invocation !== 'object' || !TOOL_NAME_RE.test(String(invocation.name || '').trim())) {
      throw new AiToolExecutionError('INVALID_INVOCATION', 'Malformed AI tool invocation.');
    }

    const name = String(invocation.name).trim();
    const definition = this.tools.get(name);
    if (!definition) throw new AiToolExecutionError('UNKNOWN_TOOL', `Unknown AI tool: ${name}`);

    assertNoReservedModelFields(invocation.arguments);
    const parsed = definition.inputSchema.safeParse(invocation.arguments);
    if (!parsed.success) {
      throw new AiToolExecutionError('INVALID_ARGUMENTS', 'AI tool arguments failed schema validation.');
    }

    const trusted = parseTrustedContext(definition, context);
    const scope = await this.authorize({
      actorDiscordId: trusted.actorDiscordId,
      guildId: trusted.guildId,
      nitradoConnId: trusted.nitradoConnId,
      permission: definition.permission,
      toolName: name,
      scopeKind: definition.scope,
    });

    if (!scope
      || scope.guildId !== trusted.guildId
      || scope.actorDiscordId !== trusted.actorDiscordId
      || !hasCommandPermission(scope, definition.permission)
      || (definition.scope === 'GAMESERVER' && scope.nitradoConnId !== trusted.nitradoConnId)) {
      throw new AiToolExecutionError('AUTHORIZATION_DENIED', 'AI tool authorization or exact scope validation failed.');
    }

    if (definition.risk !== 'READ_ONLY') {
      const token = String(context.stepUpToken || '').trim();
      if (!token || !this.stepUpVerifier) {
        throw new AiToolExecutionError('STEP_UP_REQUIRED', 'This AI tool requires trusted step-up confirmation.');
      }
      const binding: AiToolStepUpBinding = {
        actorDiscordId: trusted.actorDiscordId,
        guildId: trusted.guildId,
        nitradoConnId: trusted.nitradoConnId,
        toolName: name,
        argumentsDigest: digestAiToolArguments(parsed.data),
      };
      const ok = await this.stepUpVerifier.verifyAndConsume(token, binding);
      if (!ok) throw new AiToolExecutionError('STEP_UP_INVALID', 'AI tool step-up confirmation is invalid, expired or already used.');
    }

    return await definition.execute(parsed.data, {
      scope,
      actorDiscordId: trusted.actorDiscordId,
      guildId: trusted.guildId,
      nitradoConnId: trusted.nitradoConnId,
      toolName: name,
    }) as TResult;
  }
}
