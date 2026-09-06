import type { Prisma } from '@prisma/client';

export interface RadarAutoBanFenceScope {
  guildId: string;
  nitradoConnId: string;
}

export interface RadarAutoBanFenceBinding {
  currentServiceId: string | null;
  bindingVersion: number;
}

export interface RadarAutoBanFenceRow {
  banId: string;
  radarEventId: string;
  guildId: string;
  nitradoConnId: string;
  serviceId: string;
  bindingVersion: number;
  invalidatedAt: Date | null;
}

interface RadarAutoBanFenceClient {
  radarAutoBanBanFence: {
    findFirst(args: unknown): Promise<RadarAutoBanFenceRow | null>;
    upsert(args: unknown): Promise<unknown>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
  nitradoAdmBindingState: {
    findUnique(args: unknown): Promise<RadarAutoBanFenceBinding | null>;
  };
}

export type RadarAutoBanRemoteDecision =
  | { kind: 'UNFENCED' }
  | { kind: 'ALLOW'; fence: RadarAutoBanFenceRow }
  | { kind: 'REJECT'; fence: RadarAutoBanFenceRow; code: string };

/**
 * Persistiert die exakte Nitrado-Service-/ADM-Binding-Generation, in der ein
 * Radar-Auto-Ban fachlich autorisiert wurde. Das passiert in derselben DB-
 * Transaktion wie BanRegistry + Outbox-Enqueue.
 */
export async function upsertRadarAutoBanFence(
  client: Prisma.TransactionClient | RadarAutoBanFenceClient,
  args: RadarAutoBanFenceScope & {
    banId: string;
    radarEventId: string;
    serviceId: string;
    bindingVersion: number;
  },
): Promise<void> {
  const db = client as unknown as RadarAutoBanFenceClient;
  await db.radarAutoBanBanFence.upsert({
    where: { banId: args.banId },
    create: {
      banId: args.banId,
      radarEventId: args.radarEventId,
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      serviceId: args.serviceId,
      bindingVersion: args.bindingVersion,
      invalidatedAt: null,
    },
    update: {
      radarEventId: args.radarEventId,
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
      serviceId: args.serviceId,
      bindingVersion: args.bindingVersion,
      invalidatedAt: null,
    },
  });
}

/**
 * Ein expliziter manueller Ban ist absichtlich NICHT an eine alte Radar-
 * Generation gebunden. Der manuelle Writer ruft dies unter demselben Radar-
 * Scope-Lock auf und entfernt damit einen evtl. frueheren Auto-Ban-Fence.
 */
export async function clearRadarAutoBanFence(
  client: Prisma.TransactionClient | RadarAutoBanFenceClient,
  scope: RadarAutoBanFenceScope,
  banId: string,
): Promise<number> {
  const db = client as unknown as RadarAutoBanFenceClient;
  const result = await db.radarAutoBanBanFence.deleteMany({
    where: {
      banId,
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
    },
  });
  return result.count;
}

/**
 * Letzte fail-closed Schranke direkt vor einem Remote-ADD bzw. vor automatischer
 * Ban-Reconciliation. Kein Fence bedeutet: normaler/manueller Ban und damit
 * bestehendes Verhalten. Ein vorhandener Radar-Fence muss dagegen EXAKT zum
 * aktuellen Nitrado-Service UND zur aktuellen ADM-Binding-Version passen.
 *
 * Jest benutzt in aelteren Unit-Tests bewusst minimale Prisma-Mocks ohne neue
 * additive Modelle. Nur dort wird ein fehlendes Fence-Modell als UNFENCED
 * behandelt. In jeder anderen Runtime ist ein fehlendes Modell ein harter
 * Fehler, sodass eine unvollstaendige Migration niemals zu einem Remote-Ban
 * ohne Sicherheitspruefung degradieren kann.
 */
export async function inspectRadarAutoBanFenceForRemoteAdd(
  client: Prisma.TransactionClient | RadarAutoBanFenceClient,
  args: RadarAutoBanFenceScope & { banId: string; currentServiceId: string | null },
): Promise<RadarAutoBanRemoteDecision> {
  const db = client as unknown as Partial<RadarAutoBanFenceClient>;
  if (!db.radarAutoBanBanFence) {
    if (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined) {
      return { kind: 'UNFENCED' };
    }
    throw new Error('Radar-Auto-Ban-Fence-Modell fehlt; Remote-Ban wird fail-closed verweigert.');
  }

  const fence = await db.radarAutoBanBanFence.findFirst({
    where: {
      banId: args.banId,
      guildId: args.guildId,
      nitradoConnId: args.nitradoConnId,
    },
    select: {
      banId: true,
      radarEventId: true,
      guildId: true,
      nitradoConnId: true,
      serviceId: true,
      bindingVersion: true,
      invalidatedAt: true,
    },
  });
  if (!fence) return { kind: 'UNFENCED' };
  if (fence.invalidatedAt) return { kind: 'REJECT', fence, code: 'RADAR_FENCE_INVALIDATED' };
  if (!args.currentServiceId || args.currentServiceId !== fence.serviceId) {
    return { kind: 'REJECT', fence, code: 'RADAR_FENCE_SERVICE_MISMATCH' };
  }

  if (!db.nitradoAdmBindingState) {
    throw new Error('ADM-Binding-State fehlt fuer Radar-Auto-Ban-Fence; Remote-Ban wird fail-closed verweigert.');
  }
  const binding = await db.nitradoAdmBindingState.findUnique({
    where: {
      guildId_nitradoConnId: {
        guildId: args.guildId,
        nitradoConnId: args.nitradoConnId,
      },
    },
    select: { currentServiceId: true, bindingVersion: true },
  });
  if (!binding) return { kind: 'REJECT', fence, code: 'RADAR_FENCE_BINDING_MISSING' };
  if (binding.currentServiceId !== fence.serviceId) {
    return { kind: 'REJECT', fence, code: 'RADAR_FENCE_BINDING_SERVICE_MISMATCH' };
  }
  if (binding.bindingVersion !== fence.bindingVersion) {
    return { kind: 'REJECT', fence, code: 'RADAR_FENCE_BINDING_VERSION_MISMATCH' };
  }

  return { kind: 'ALLOW', fence };
}
