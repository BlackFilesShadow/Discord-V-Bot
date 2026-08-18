export interface AdmBindingScope {
  guildId: string;
  nitradoConnId: string;
}

export interface AdmBindingStateRow {
  guildId: string;
  nitradoConnId: string;
  bindingVersion: number;
  currentServiceId: string | null;
}

export interface AdmBindingStateClient {
  nitradoAdmBindingState: {
    findUnique(args: unknown): Promise<AdmBindingStateRow | null>;
    create(args: unknown): Promise<AdmBindingStateRow>;
    update(args: unknown): Promise<AdmBindingStateRow>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

/**
 * Synchronisiert den persistenten ADM-Namespace mit der aktuell gebundenen
 * Nitrado-Service-ID. Muss unter dem per-Connection Config-Lock laufen.
 *
 * Backward compatibility:
 * - der erste Zustand startet immer auf Version 0
 * - nur ein tatsaechlicher Service-Wechsel erhoeht die Version
 */
export async function syncAdmBindingState(
  client: AdmBindingStateClient,
  scope: AdmBindingScope,
  currentServiceId: string | null,
): Promise<AdmBindingStateRow> {
  const key = {
    guildId_nitradoConnId: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
    },
  };
  const existing = await client.nitradoAdmBindingState.findUnique({ where: key });
  if (!existing) {
    return client.nitradoAdmBindingState.create({
      data: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        bindingVersion: 0,
        currentServiceId,
      },
    });
  }
  if (existing.currentServiceId === currentServiceId) return existing;

  return client.nitradoAdmBindingState.update({
    where: key,
    data: {
      currentServiceId,
      bindingVersion: { increment: 1 },
    },
  });
}

export function admBindingFileIdentityPrefix(bindingVersion: number): string | null {
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 0) {
    throw new Error('Ungueltige ADM-Binding-Version');
  }
  return bindingVersion === 0 ? null : `adm-binding:${bindingVersion}:`;
}

/**
 * Existing version-0 cursors/events keep their historical file identity.
 * Every later service binding gets a disjoint source namespace.
 */
export function admBindingFileIdentity(bindingVersion: number, fileName: string): string {
  const prefix = admBindingFileIdentityPrefix(bindingVersion);
  return prefix ? `${prefix}${fileName}` : fileName;
}
