import {
  deleteGeneratedLiveServerKnowledge,
  type LiveServerKnowledgeLifecycleClient,
} from '../../ai/liveServerKnowledgeLifecycle';

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

export interface AdmBindingStateClient extends LiveServerKnowledgeLifecycleClient {
  nitradoAdmBindingState: {
    findUnique(args: unknown): Promise<AdmBindingStateRow | null>;
    create(args: unknown): Promise<AdmBindingStateRow>;
    update(args: unknown): Promise<AdmBindingStateRow>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

function bindingKey(scope: AdmBindingScope) {
  return {
    guildId_nitradoConnId: {
      guildId: scope.guildId,
      nitradoConnId: scope.nitradoConnId,
    },
  };
}

/**
 * Synchronisiert den persistenten ADM-Namespace mit der aktuell gebundenen
 * Nitrado-Service-ID. Muss unter dem per-Connection Config-Lock laufen.
 *
 * Backward compatibility:
 * - der erste Zustand startet immer auf Version 0
 * - nur ein tatsaechlicher Service-Wechsel erhoeht die Version
 * - vor einem echten Service-Wechsel wird systemgeneriertes LIVE_SERVER-Wissen
 *   fuer die alte Generation fail-closed entfernt
 */
export async function syncAdmBindingState(
  client: AdmBindingStateClient,
  scope: AdmBindingScope,
  currentServiceId: string | null,
): Promise<AdmBindingStateRow> {
  const key = bindingKey(scope);
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

  await deleteGeneratedLiveServerKnowledge(client, scope.guildId, scope.nitradoConnId);

  return client.nitradoAdmBindingState.update({
    where: key,
    data: {
      currentServiceId,
      bindingVersion: { increment: 1 },
    },
  });
}

/**
 * Nitrado-1U: ACTIVE ist nicht nur ein Anzeige-Status, sondern Teil der
 * Remote-Binding-Lebensdauer. ACTIVE -> non-ACTIVE -> ACTIVE mit identischem
 * Token/Service darf deshalb niemals eine alte Remote-Beobachtung oder altes
 * LIVE_SERVER-Wissen wieder gueltig machen.
 *
 * Der Caller muss wie bei syncAdmBindingState den Connection-Config-Lock halten
 * und diese Mutation im selben DB-Commit wie die Statusaenderung ausfuehren.
 * Ein fehlender Legacy-State beginnt fuer diese echte Lifecycle-Grenze bewusst
 * bei Generation 1 statt 0.
 */
export async function advanceAdmBindingLifecycleGeneration(
  client: AdmBindingStateClient,
  scope: AdmBindingScope,
  currentServiceId: string | null,
): Promise<AdmBindingStateRow> {
  const key = bindingKey(scope);
  const existing = await client.nitradoAdmBindingState.findUnique({ where: key });

  await deleteGeneratedLiveServerKnowledge(client, scope.guildId, scope.nitradoConnId);

  if (!existing) {
    return client.nitradoAdmBindingState.create({
      data: {
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        bindingVersion: 1,
        currentServiceId,
      },
    });
  }

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
 * Every later service/lifecycle binding gets a disjoint source namespace.
 */
export function admBindingFileIdentity(bindingVersion: number, fileName: string): string {
  const prefix = admBindingFileIdentityPrefix(bindingVersion);
  return prefix ? `${prefix}${fileName}` : fileName;
}
