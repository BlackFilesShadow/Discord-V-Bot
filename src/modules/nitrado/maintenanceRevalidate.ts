import prisma from '../../database/prisma';
import { config } from '../../config';
import { decrypt } from '../../utils/security';
import { asGuildId, asNitradoConnId } from '../../types/scope';
import { NitradoClient, type TokenValidationResult } from './nitradoClient';
import { markValidated, setStatus } from './repository';
import { tryAcquireNitradoConfigMutationLock } from './configMutationLock';

export type MaintenanceRevalidateResult =
  | { kind: 'BUSY'; id: string; guildId: string }
  | { kind: 'MISSING'; id: string; guildId: string }
  | { kind: 'DECRYPT_FAILED'; id: string; guildId: string; alias: string; slot: number }
  | { kind: 'VALID'; id: string; guildId: string; alias: string; slot: number; previousStatus: string }
  | { kind: 'INVALID'; id: string; guildId: string; alias: string; slot: number; previousStatus: string; status: 401 | 403 | null }
  | { kind: 'TRANSIENT'; id: string; guildId: string; alias: string; slot: number; previousStatus: string; result: Exclude<TokenValidationResult, { kind: 'VALID' } | { kind: 'INVALID' }> };

/**
 * Kanonische manuelle Token-Revalidierung fuer das Ops-Skript.
 *
 * Der uebergebene Kandidat ist niemals Autoritaet. Genau wie der Runtime-Cron
 * wird zuerst derselbe per-Connection-Lock wie Worker/Token-/Service-Mutationen
 * gewonnen und erst DANACH der aktuelle Guild+Connection-Snapshot gelesen.
 * Der Lock bleibt bis nach Remote-Validierung und Status-Write gehalten, damit
 * ein altes Validierungsergebnis keine parallele Tokenrotation ueberschreibt.
 */
export async function revalidateConnectionMaintenanceOnce(candidate: {
  id: string;
  guildId: string;
}): Promise<MaintenanceRevalidateResult> {
  const lock = await tryAcquireNitradoConfigMutationLock(candidate.id);
  if (!lock) return { kind: 'BUSY', id: candidate.id, guildId: candidate.guildId };

  try {
    const fresh = await prisma.nitradoConnection.findFirst({
      where: {
        id: candidate.id,
        guildId: candidate.guildId,
        status: { in: ['ACTIVE', 'EXPIRED'] },
      },
      select: {
        id: true,
        guildId: true,
        slot: true,
        alias: true,
        status: true,
        encryptedToken: true,
      },
    });
    if (!fresh) return { kind: 'MISSING', id: candidate.id, guildId: candidate.guildId };

    let token: string;
    try {
      token = decrypt(fresh.encryptedToken, config.security.encryptionKey);
    } catch {
      return {
        kind: 'DECRYPT_FAILED',
        id: fresh.id,
        guildId: fresh.guildId,
        alias: fresh.alias,
        slot: fresh.slot,
      };
    }

    const result = await new NitradoClient(token).validateTokenDetailed();
    if (result.kind === 'VALID') {
      await markValidated(asGuildId(fresh.guildId), asNitradoConnId(fresh.id));
      return {
        kind: 'VALID',
        id: fresh.id,
        guildId: fresh.guildId,
        alias: fresh.alias,
        slot: fresh.slot,
        previousStatus: fresh.status,
      };
    }

    if (result.kind === 'INVALID') {
      await setStatus(asGuildId(fresh.guildId), asNitradoConnId(fresh.id), 'EXPIRED');
      return {
        kind: 'INVALID',
        id: fresh.id,
        guildId: fresh.guildId,
        alias: fresh.alias,
        slot: fresh.slot,
        previousStatus: fresh.status,
        status: result.status,
      };
    }

    return {
      kind: 'TRANSIENT',
      id: fresh.id,
      guildId: fresh.guildId,
      alias: fresh.alias,
      slot: fresh.slot,
      previousStatus: fresh.status,
      result,
    };
  } finally {
    await lock.release();
  }
}
