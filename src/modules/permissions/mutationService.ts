import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import prisma from '../../database/prisma';
import type { GuildId, PermissionScope, UserDiscordId } from '../../types/scope';
import { sanitizeDelegablePermissionScopes } from './policy';

export type PermissionGrantTargetKind = 'USER' | 'ROLE';
export type PermissionGrantMutation = 'GRANT' | 'REVOKE' | 'PURGE';

export interface PermissionMutationInput {
  guildId: GuildId;
  targetKind: PermissionGrantTargetKind;
  targetId: string;
  action: PermissionGrantMutation;
  permission?: PermissionScope;
  grantedBy: UserDiscordId;
}

export interface PermissionMutationResult {
  permissions: PermissionScope[];
  changed: boolean;
  existed: boolean;
}

export function permissionMutationLockKeys(
  guildId: string,
  targetKind: PermissionGrantTargetKind,
  targetId: string,
): [number, number] {
  const digest = crypto
    .createHash('sha256')
    .update(`permission-grant:v1:${guildId}:${targetKind}:${targetId}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

async function acquireTargetLock(
  tx: Prisma.TransactionClient,
  guildId: string,
  targetKind: PermissionGrantTargetKind,
  targetId: string,
): Promise<void> {
  const [key1, key2] = permissionMutationLockKeys(guildId, targetKind, targetId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(${key1}, ${key2})`;
}

function samePermissions(a: readonly PermissionScope[], b: readonly PermissionScope[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Single mutation engine for dashboard and slash-command permission writes.
 * The PostgreSQL transaction-scoped advisory lock serializes every target across
 * processes without holding an HTTP request open around unrelated work.
 */
export async function mutatePermissionGrant(
  input: PermissionMutationInput,
): Promise<PermissionMutationResult> {
  if (input.action !== 'PURGE' && !input.permission) {
    throw new Error('Permission fehlt fuer Grant/Revoke.');
  }

  return prisma.$transaction(async tx => {
    await acquireTargetLock(tx, input.guildId, input.targetKind, input.targetId);

    if (input.targetKind === 'USER') {
      const where = {
        guildId_userDiscordId: {
          guildId: input.guildId,
          userDiscordId: input.targetId,
        },
      };
      const existing = await tx.guildPermissionGrant.findUnique({ where });
      if (input.action === 'PURGE') {
        if (existing) await tx.guildPermissionGrant.delete({ where });
        return { permissions: [], changed: !!existing, existed: !!existing };
      }

      const current = sanitizeDelegablePermissionScopes(existing?.permissions);
      const nextSet = new Set<PermissionScope>(current);
      if (input.action === 'GRANT') nextSet.add(input.permission!);
      else nextSet.delete(input.permission!);
      const next = [...nextSet].sort();

      if (next.length === 0) {
        if (existing) await tx.guildPermissionGrant.delete({ where });
        return {
          permissions: [],
          changed: !!existing,
          existed: !!existing,
        };
      }

      const rawWasClean = existing
        ? samePermissions(sanitizeDelegablePermissionScopes(existing.permissions), next)
          && Array.isArray(existing.permissions)
          && existing.permissions.length === next.length
        : false;
      await tx.guildPermissionGrant.upsert({
        where,
        create: {
          guildId: input.guildId,
          userDiscordId: input.targetId,
          permissions: next,
          grantedByDiscordId: input.grantedBy,
        },
        update: {
          permissions: next,
          grantedByDiscordId: input.grantedBy,
        },
      });
      return {
        permissions: next,
        changed: !existing || !rawWasClean,
        existed: !!existing,
      };
    }

    const where = {
      guildId_roleDiscordId: {
        guildId: input.guildId,
        roleDiscordId: input.targetId,
      },
    };
    const existing = await tx.guildPermissionRoleGrant.findUnique({ where });
    if (input.action === 'PURGE') {
      if (existing) await tx.guildPermissionRoleGrant.delete({ where });
      return { permissions: [], changed: !!existing, existed: !!existing };
    }

    const current = sanitizeDelegablePermissionScopes(existing?.permissions);
    const nextSet = new Set<PermissionScope>(current);
    if (input.action === 'GRANT') nextSet.add(input.permission!);
    else nextSet.delete(input.permission!);
    const next = [...nextSet].sort();

    if (next.length === 0) {
      if (existing) await tx.guildPermissionRoleGrant.delete({ where });
      return {
        permissions: [],
        changed: !!existing,
        existed: !!existing,
      };
    }

    const rawWasClean = existing
      ? samePermissions(sanitizeDelegablePermissionScopes(existing.permissions), next)
        && Array.isArray(existing.permissions)
        && existing.permissions.length === next.length
      : false;
    await tx.guildPermissionRoleGrant.upsert({
      where,
      create: {
        guildId: input.guildId,
        roleDiscordId: input.targetId,
        permissions: next,
        grantedByDiscordId: input.grantedBy,
      },
      update: {
        permissions: next,
        grantedByDiscordId: input.grantedBy,
      },
    });
    return {
      permissions: next,
      changed: !existing || !rawWasClean,
      existed: !!existing,
    };
  });
}
