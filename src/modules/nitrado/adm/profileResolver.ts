import prisma from '../../../database/prisma';
import { NitradoClient } from '../nitradoClient';

export interface AdmConnectionScope {
  id: string;
  guildId: string;
  nitradoServerId: string;
}

export interface ResolvedAdmProfile {
  profileDir: string;
  timeZone: string | null;
  source: string;
}

function cleanRemoteDir(value: string): string | null {
  const raw = value.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!raw || raw.includes('..') || /[\r\n\0]/.test(raw)) return null;
  const prefixed = raw.startsWith('/') ? raw : `/${raw}`;
  return prefixed.replace(/\/{2,}/g, '/');
}

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function joinRemote(base: string, child: string): string | null {
  const cleanedBase = cleanRemoteDir(base);
  if (!cleanedBase) return null;
  return cleanRemoteDir(`${cleanedBase}/${child}`);
}

function unique<T>(values: Array<T | null | undefined>): T[] {
  return Array.from(new Set(values.filter((value): value is T => value != null)));
}

async function dirWorks(client: NitradoClient, serviceId: string, dir: string): Promise<boolean> {
  try {
    await client.listDir(serviceId, dir);
    return true;
  } catch {
    return false;
  }
}

async function persistResolved(
  scope: AdmConnectionScope,
  profileDir: string,
  source: string,
  timeZone: string | null,
): Promise<ResolvedAdmProfile> {
  const row = await prisma.nitradoAdmProfileConfig.upsert({
    where: {
      guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: scope.id },
    },
    create: {
      guildId: scope.guildId,
      nitradoConnId: scope.id,
      profileDir,
      source,
      timeZone,
      lastVerifiedAt: new Date(),
      lastError: null,
    },
    update: {
      profileDir,
      source,
      timeZone,
      lastVerifiedAt: new Date(),
      lastError: null,
    },
  });
  return { profileDir: row.profileDir, timeZone: row.timeZone, source: row.source };
}

/**
 * Resolve the ADM directory once per Nitrado connection and persist it. Manual
 * config wins; AUTO entries are revalidated and rediscovered when they become
 * invalid. NITRADO_ADM_DIR is only a legacy fallback and is copied into the
 * per-server row after verification.
 */
export async function resolveAdmProfile(
  scope: AdmConnectionScope,
  client: NitradoClient,
): Promise<ResolvedAdmProfile> {
  const existing = await prisma.nitradoAdmProfileConfig.findUnique({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: scope.id } },
  });

  if (existing) {
    const configured = cleanRemoteDir(existing.profileDir);
    if (configured && await dirWorks(client, scope.nitradoServerId, configured)) {
      await prisma.nitradoAdmProfileConfig.updateMany({
        where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
        data: { profileDir: configured, lastVerifiedAt: new Date(), lastError: null },
      });
      return { profileDir: configured, timeZone: existing.timeZone, source: existing.source };
    }
    if (existing.source === 'MANUAL') {
      const message = 'Manuell konfiguriertes ADM-Verzeichnis ist bei Nitrado nicht erreichbar.';
      await prisma.nitradoAdmProfileConfig.updateMany({
        where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
        data: { lastError: message },
      });
      throw new Error(message);
    }
  }

  const info = await client.getGameserverInfo(scope.nitradoServerId);
  const legacyEnv = cleanRemoteDir(process.env.NITRADO_ADM_DIR ?? '');
  const gamePath = cleanRemoteDir(info.path || '');
  const username = info.username.trim();
  const userRoot = username ? cleanRemoteDir(`/games/${username}`) : null;

  const candidates = unique([
    legacyEnv,
    gamePath ? joinRemote(gamePath, 'logs') : null,
    userRoot ? joinRemote(userRoot, 'dayzstandalone/logs') : null,
    userRoot ? joinRemote(userRoot, 'dayzstandalone/profiles') : null,
    userRoot ? joinRemote(userRoot, 'dayzxb/profiles') : null,
    userRoot ? joinRemote(userRoot, 'dayzps/profiles') : null,
    gamePath ? joinRemote(gamePath, 'profiles') : null,
    gamePath,
  ]);

  // Prefer a candidate that already contains ADM files; otherwise an existing
  // directory is sufficient for a freshly created server whose first ADM log
  // has not been written yet.
  let firstExisting: string | null = null;
  for (const candidate of candidates) {
    try {
      const entries = await client.listAdmFiles(scope.nitradoServerId, candidate);
      if (!firstExisting) firstExisting = candidate;
      if (entries.length > 0) {
        return persistResolved(scope, candidate, candidate === legacyEnv ? 'LEGACY_ENV' : 'AUTO', existing?.timeZone ?? null);
      }
    } catch {
      // Try next known DayZ layout.
    }
  }
  if (firstExisting) {
    return persistResolved(scope, firstExisting, firstExisting === legacyEnv ? 'LEGACY_ENV' : 'AUTO', existing?.timeZone ?? null);
  }

  // Last-resort recursive search supported by Nitrado's FileServer API. Search
  // results may expose either path or a slash-containing name depending on host.
  const roots = unique([gamePath, userRoot, '/games']);
  for (const root of roots) {
    try {
      const matches = await client.searchFiles(scope.nitradoServerId, root, '.ADM');
      for (const match of matches) {
        const location = match.path || match.name;
        if (!location.toLowerCase().includes('.adm')) continue;
        const normalized = cleanRemoteDir(location);
        if (!normalized) continue;
        const slash = normalized.lastIndexOf('/');
        if (slash <= 0) continue;
        const dir = normalized.slice(0, slash);
        if (await dirWorks(client, scope.nitradoServerId, dir)) {
          return persistResolved(scope, dir, 'AUTO_SEARCH', existing?.timeZone ?? null);
        }
      }
    } catch {
      // Continue with next root.
    }
  }

  const message = 'ADM-Verzeichnis konnte auf diesem Nitrado-Gameserver nicht automatisch gefunden werden.';
  if (existing) {
    await prisma.nitradoAdmProfileConfig.updateMany({
      where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
      data: { lastError: message },
    });
  }
  throw new Error(message);
}

export async function setManualAdmProfile(
  scope: AdmConnectionScope,
  client: NitradoClient,
  profileDir: string,
  timeZone: string | null,
): Promise<ResolvedAdmProfile> {
  const dir = cleanRemoteDir(profileDir);
  if (!dir) throw new Error('Ungueltiges ADM-Verzeichnis.');
  if (timeZone && !isValidIanaTimeZone(timeZone)) throw new Error('Ungueltige IANA-Zeitzone.');
  if (!(await dirWorks(client, scope.nitradoServerId, dir))) {
    throw new Error('ADM-Verzeichnis ist bei Nitrado nicht erreichbar.');
  }
  return persistResolved(scope, dir, 'MANUAL', timeZone,);
}
