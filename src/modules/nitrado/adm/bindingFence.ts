import prisma from '../../../database/prisma';
import { tryAcquireNitradoConfigMutationLock } from '../configMutationLock';
import { syncAdmBindingState, type AdmBindingStateClient } from './bindingState';

export interface AdmBindingSnapshot {
  id: string;
  guildId: string;
  encryptedToken: string;
  nitradoServerId: string;
  bindingVersion: number;
}

export class AdmBindingBusyError extends Error {
  constructor() {
    super('Nitrado-Connection wird gerade exklusiv verwendet; ADM-Bindung kann nicht sicher gelesen werden.');
    this.name = 'AdmBindingBusyError';
  }
}

export class AdmBindingStaleError extends Error {
  constructor() {
    super('ADM-Ergebnis gehoert nicht mehr zur aktuellen Nitrado-Bindung.');
    this.name = 'AdmBindingStaleError';
  }
}

/**
 * Liest die kanonische ACTIVE-ADM-Bindung unter demselben kurzen Advisory-Lock,
 * den Token-/Service-/Delete-Mutationen verwenden. Remote-I/O findet erst nach
 * Freigabe des Locks statt.
 */
export async function readCurrentAdmBinding(scope: {
  id: string;
  guildId: string;
}): Promise<AdmBindingSnapshot | null> {
  const lock = await tryAcquireNitradoConfigMutationLock(scope.id);
  if (!lock) throw new AdmBindingBusyError();
  try {
    const conn = await prisma.nitradoConnection.findFirst({
      where: {
        id: scope.id,
        guildId: scope.guildId,
        status: 'ACTIVE',
        nitradoServerId: { not: null },
      },
      select: {
        id: true,
        guildId: true,
        encryptedToken: true,
        nitradoServerId: true,
      },
    });
    if (!conn?.nitradoServerId) return null;

    const binding = await syncAdmBindingState(
      prisma as unknown as AdmBindingStateClient,
      { guildId: conn.guildId, nitradoConnId: conn.id },
      conn.nitradoServerId,
    );
    return {
      id: conn.id,
      guildId: conn.guildId,
      encryptedToken: conn.encryptedToken,
      nitradoServerId: conn.nitradoServerId,
      bindingVersion: binding.bindingVersion,
    };
  } finally {
    await lock.release();
  }
}

/**
 * Revalidiert einen zuvor remote verwendeten ADM-Snapshot unmittelbar vor
 * einem lokalen Side-Effect und fuehrt genau diesen Side-Effect noch unter dem
 * Config-Lock aus. Dadurch kann kein Token-/Service-/Delete-Commit zwischen
 * Freshness-Check und Persistenz rutschen.
 */
export async function withFreshAdmBinding<T>(
  snapshot: AdmBindingSnapshot,
  work: () => Promise<T>,
): Promise<T> {
  const lock = await tryAcquireNitradoConfigMutationLock(snapshot.id);
  if (!lock) throw new AdmBindingBusyError();
  try {
    const [conn, binding] = await Promise.all([
      prisma.nitradoConnection.findFirst({
        where: {
          id: snapshot.id,
          guildId: snapshot.guildId,
          status: 'ACTIVE',
          encryptedToken: snapshot.encryptedToken,
          nitradoServerId: snapshot.nitradoServerId,
        },
        select: { id: true },
      }),
      prisma.nitradoAdmBindingState.findUnique({
        where: {
          guildId_nitradoConnId: {
            guildId: snapshot.guildId,
            nitradoConnId: snapshot.id,
          },
        },
        select: { bindingVersion: true, currentServiceId: true },
      }),
    ]);

    if (
      !conn
      || !binding
      || binding.bindingVersion !== snapshot.bindingVersion
      || binding.currentServiceId !== snapshot.nitradoServerId
    ) {
      throw new AdmBindingStaleError();
    }
    return await work();
  } finally {
    await lock.release();
  }
}

export function isAdmBindingFenceError(error: unknown): boolean {
  return error instanceof AdmBindingBusyError || error instanceof AdmBindingStaleError;
}
