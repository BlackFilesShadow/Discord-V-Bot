/**
 * Production AI tool runtime (AI-18).
 *
 * Wires AiToolExecutor into the trusted application boundary:
 *   model proposal → schema → AuthZ → exact guild/games server scope →
 *   step-up (mutating/destructive) → domain handler → audit → result
 *
 * The LLM never receives the step-up secret and never issues grants.
 * Only READ_ONLY tools are registered by default; destructive Nitrado/DB
 * mutations are intentionally fail-closed (not registered).
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { getDashboardClient, tryGetDashboardClient } from '../../dashboard/clientRegistry';
import prisma from '../../database/prisma';
import { AiToolStepUpService } from '../../security/aiToolStepUp';
import {
  asGuildId,
  asNitradoConnId,
  asUserDiscordId,
  type GuildScope,
  type PermissionScope,
} from '../../types/scope';
import { config } from '../../config';
import { logAudit, logger } from '../../utils/logger';
import { getById } from '../nitrado/repository';
import { resolveDelegatedPermissionContext } from '../permissions/access';
import {
  AiToolExecutionError,
  AiToolExecutor,
  type AiToolAuthorizationRequest,
  type AiToolExecutionContext,
  type AiToolInvocation,
} from './toolLayer';

const IDEMPOTENCY_TTL_MS = 10 * 60_000;
const MAX_IDEMPOTENCY_ENTRIES = 2_000;

export interface AiToolRuntimeRequest {
  invocation: AiToolInvocation;
  /** Trusted application context — never taken from model output. */
  context: AiToolExecutionContext;
  /**
   * Optional client-supplied key for safe retries of READ_ONLY tools.
   * Mutating tools still require a fresh step-up token (one-shot).
   */
  idempotencyKey?: string | null;
}

export interface AiToolRuntimeResult<T = unknown> {
  ok: true;
  toolName: string;
  result: T;
  idempotentReplay: boolean;
}

export interface AiToolRuntimeFailure {
  ok: false;
  code: string;
  message: string;
}

type CachedResult = {
  expiresAt: number;
  payload: AiToolRuntimeResult;
};

let executorSingleton: AiToolExecutor | null = null;
let stepUpSingleton: AiToolStepUpService | null = null;
const idempotencyCache = new Map<string, CachedResult>();

function pruneIdempotency(now = Date.now()): void {
  for (const [key, entry] of idempotencyCache) {
    if (entry.expiresAt <= now) idempotencyCache.delete(key);
  }
  while (idempotencyCache.size > MAX_IDEMPOTENCY_ENTRIES) {
    const oldest = idempotencyCache.keys().next().value;
    if (oldest === undefined) break;
    idempotencyCache.delete(oldest);
  }
}

function idempotencyCacheKey(
  request: AiToolRuntimeRequest,
  toolName: string,
): string | null {
  const raw = String(request.idempotencyKey || '').trim();
  if (!raw) return null;
  const ctx = request.context;
  return crypto
    .createHash('sha256')
    .update([
      raw,
      toolName,
      String(ctx.actorDiscordId || ''),
      String(ctx.guildId || ''),
      String(ctx.nitradoConnId || ''),
      JSON.stringify(request.invocation?.arguments ?? null),
    ].join('|'))
    .digest('hex');
}

function resolveStepUpSecret(): string {
  // Prefer dedicated secret; fall back to dashboard session secret / encryption key.
  const candidate = process.env.AI_TOOL_STEP_UP_SECRET
    || config.dashboard.sessionSecret
    || config.security.encryptionKey;
  if (Buffer.byteLength(candidate, 'utf8') < 32) {
    throw new Error('AI tool step-up secret must contain at least 32 bytes.');
  }
  return candidate;
}

export function getAiToolStepUpService(): AiToolStepUpService {
  if (!stepUpSingleton) {
    stepUpSingleton = new AiToolStepUpService(resolveStepUpSecret());
  }
  return stepUpSingleton;
}

/**
 * Authorizer used by the production executor.
 * Fail-closed: missing Discord client, missing membership, wrong connection → null.
 */
export async function authorizeAiToolRequest(
  request: AiToolAuthorizationRequest,
): Promise<GuildScope | null> {
  try {
    const guildId = asGuildId(request.guildId);
    const actorDiscordId = asUserDiscordId(request.actorDiscordId);
    const nitradoConnId = request.nitradoConnId
      ? asNitradoConnId(request.nitradoConnId)
      : null;

    if (request.scopeKind === 'GAMESERVER') {
      if (!nitradoConnId) return null;
      const conn = await getById(guildId, nitradoConnId);
      if (!conn || conn.guildId !== guildId) return null;
    } else if (nitradoConnId) {
      // Guild-scoped tools must not smuggle a gameserver id as trusted scope.
      return null;
    }

    const client = tryGetDashboardClient();
    if (!client) return null;
    const guild = client.guilds.cache.get(guildId)
      ?? await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return null;

    const isOwner = guild.ownerId === actorDiscordId;
    let permissions = new Set<PermissionScope>();
    if (!isOwner) {
      const delegated = await resolveDelegatedPermissionContext(guild, actorDiscordId);
      if (!delegated.member) return null;
      permissions = delegated.permissions;
    }

    return {
      guildId,
      nitradoConnId,
      actorDiscordId,
      isOwner,
      permissions,
    };
  } catch {
    return null;
  }
}

function registerProductionTools(executor: AiToolExecutor): void {
  executor.register({
    name: 'nitrado.connection.status',
    description: 'Read-only Nitrado connection status for the exact trusted gameserver scope.',
    risk: 'READ_ONLY',
    scope: 'GAMESERVER',
    permission: 'nitrado.view',
    inputSchema: z.object({
      includeAlias: z.boolean().optional().default(true),
    }).strict(),
    execute: async (input, ctx) => {
      if (!ctx.nitradoConnId) {
        throw new AiToolExecutionError('INVALID_SCOPE', 'Gameserver scope required.');
      }
      const row = await getById(asGuildId(ctx.guildId), asNitradoConnId(ctx.nitradoConnId));
      if (!row) {
        throw new AiToolExecutionError('AUTHORIZATION_DENIED', 'Connection not found in guild scope.');
      }
      return {
        guildId: row.guildId,
        nitradoConnId: row.id,
        slot: row.slot,
        status: row.status,
        alias: input.includeAlias ? row.alias : undefined,
        hasServerId: typeof row.nitradoServerId === 'string' && row.nitradoServerId.length > 0,
        // Never expose tokens or encrypted material.
      };
    },
  });

  executor.register({
    name: 'ai.tools.catalog',
    description: 'List tools currently available in the production AI tool registry (metadata only).',
    risk: 'READ_ONLY',
    scope: 'GUILD',
    permission: 'dashboard.view',
    inputSchema: z.object({}).strict(),
    execute: async (_input, ctx) => {
      const tools = getProductionAiToolExecutor().describe();
      return {
        guildId: ctx.guildId,
        tools: tools.map(t => ({
          name: t.name,
          description: t.description,
          risk: t.risk,
          scope: t.scope,
          permission: t.permission,
        })),
      };
    },
  });
}

/**
 * Process-wide production executor. Safe to call repeatedly (idempotent init).
 */
export function getProductionAiToolExecutor(): AiToolExecutor {
  if (executorSingleton) return executorSingleton;
  const executor = new AiToolExecutor(
    authorizeAiToolRequest,
    getAiToolStepUpService(),
  );
  registerProductionTools(executor);
  executorSingleton = executor;
  logger.info(`[AI-18] Production tool runtime ready (${executor.describe().length} tool(s)).`);
  return executor;
}

/** Test-only reset. */
export function resetProductionAiToolRuntimeForTests(): void {
  executorSingleton = null;
  stepUpSingleton = null;
  idempotencyCache.clear();
}

/**
 * Canonical production entry: every model-proposed side effect must pass here.
 * Returns a structured failure instead of throwing for caller-friendly surfaces.
 */
export async function executeProductionAiTool(
  request: AiToolRuntimeRequest,
): Promise<AiToolRuntimeResult | AiToolRuntimeFailure> {
  const executor = getProductionAiToolExecutor();
  const toolName = String(request.invocation?.name || '').trim();
  const cacheKey = idempotencyCacheKey(request, toolName);
  pruneIdempotency();

  if (cacheKey) {
    const hit = idempotencyCache.get(cacheKey);
    if (hit && hit.expiresAt > Date.now()) {
      logAudit('AI_TOOL_IDEMPOTENT_REPLAY', 'AI', {
        toolName,
        guildId: request.context.guildId,
        actorDiscordId: request.context.actorDiscordId,
        nitradoConnId: request.context.nitradoConnId ?? null,
      });
      return { ...hit.payload, idempotentReplay: true };
    }
  }

  try {
    // Ensure Discord client is resolvable before authorization (fail closed).
    if (!tryGetDashboardClient()) {
      // Touch getter for clearer operational signal when fully wired in prod.
      try {
        getDashboardClient();
      } catch {
        /* handled below */
      }
    }

    const result = await executor.execute(request.invocation, request.context);
    const payload: AiToolRuntimeResult = {
      ok: true,
      toolName,
      result,
      idempotentReplay: false,
    };

    logAudit('AI_TOOL_EXECUTED', 'AI', {
      toolName,
      guildId: request.context.guildId,
      actorDiscordId: request.context.actorDiscordId,
      nitradoConnId: request.context.nitradoConnId ?? null,
      risk: executor.describe().find(t => t.name === toolName)?.risk ?? 'UNKNOWN',
    });

    if (cacheKey) {
      idempotencyCache.set(cacheKey, {
        expiresAt: Date.now() + IDEMPOTENCY_TTL_MS,
        payload,
      });
    }

    return payload;
  } catch (error) {
    if (error instanceof AiToolExecutionError) {
      logAudit('AI_TOOL_DENIED', 'SECURITY', {
        toolName,
        code: error.code,
        guildId: request.context.guildId,
        actorDiscordId: request.context.actorDiscordId,
        nitradoConnId: request.context.nitradoConnId ?? null,
      });
      return { ok: false, code: error.code, message: error.message };
    }
    logger.error('[AI-18] Unexpected tool execution failure', error as Error);
    logAudit('AI_TOOL_ERROR', 'AI', {
      toolName,
      guildId: request.context.guildId,
      actorDiscordId: request.context.actorDiscordId,
    });
    return { ok: false, code: 'INTERNAL_ERROR', message: 'AI tool execution failed.' };
  }
}

/**
 * Assert helper for architecture/runtime: production registry must not expose
 * destructive Nitrado mutation tool names until a dedicated domain path exists.
 */
export function listProductionAiToolNames(): string[] {
  return getProductionAiToolExecutor().describe().map(t => t.name).sort();
}

/** Soft dependency keep for typecheck when prisma is needed only via repository. */
export function __aiToolRuntimeHealth(): { prismaReady: boolean; tools: number } {
  return {
    prismaReady: !!prisma,
    tools: listProductionAiToolNames().length,
  };
}
