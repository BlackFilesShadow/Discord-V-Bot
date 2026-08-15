import prisma from '../../../database/prisma';
import { NitradoClient } from '../nitradoClient';

const VERIFY_CACHE_MS = 10 * 60_000;

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

async function admDirHasFiles(client: NitradoClient, serviceId: string, dir: string): Promise<boolean> {
  try {
    const files = await client.listAdmFiles(serviceId, dir);
    return files.length > 0;
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

export async function recordAdmSourceError(scope: { id: string; guildId: string }, message: string | null): Promise<void> {
  await prisma.nitradoAdmProfileConfig.updateMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.id },
    data: { lastError: message },
  });
}

/**
 * Loest das ADM-Verzeichnis strikt pro Nitrado-Connection auf und persistiert
 * es. Manuelle Konfiguration gewinnt. AUTO-Eintraege werden nur wiederverwendet,
 * solange dort tatsaechlich ADM-Dateien liegen; dadurch heilt die Runtime auch
 * einen zuvor falsch erkannten, aber erreichbaren Leer-Pfad selbststaendig.
 * Eine globale ENV-Pfadquelle gibt es absichtlich nicht mehr.
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
    const recentlyVerified = existing.lastVerifiedAt !== null
      && Date.now() - existing.lastVerifiedAt.getTime() < VERIFY_CACHE_MS;

    if (existing.source === 'MANUAL') {
      if (configured && recentlyVerified) {
        return { profileDir: configured, timeZone: existing.timeZone, source: existing.source };
      }
      if (configured && await dirWorks(client, scope.nitradoServerId, configured)) {
        await prisma.nitradoAdmProfileConfig.updateMany({
          where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
          data: { profileDir: configured, lastVerifiedAt: new Date(), lastError: null },
        });
        return { profileDir: configured, timeZone: existing.timeZone, source: existing.source };
      }
      const message = 'Manuell konfiguriertes ADM-Verzeichnis ist bei Nitrado nicht erreichbar.';
      await prisma.nitradoAdmProfileConfig.updateMany({
        where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
        data: { lastError: message },
      });
      throw new Error(message);
    }

    // AUTO/AUTO_SEARCH darf einen vorhandenen, aber leeren Pfad nicht dauerhaft
    // cachen. Genau das passiert z.B. bei DayZ PS, wenn /logs existiert, die
    // echten DayZServer_*.ADM-Dateien aber unter <gamePath>/config liegen.
    if (configured && await admDirHasFiles(client, scope.nitradoServerId, configured)) {
      await prisma.nitradoAdmProfileConfig.updateMany({
        where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
        data: { profileDir: configured, lastVerifiedAt: new Date(), lastError: null },
      });
      return { profileDir: configured, timeZone: existing.timeZone, source: existing.source };
    }
  }

  const info = await client.getGameserverInfo(scope.nitradoServerId);
  const gamePath = cleanRemoteDir(info.path || '');
  const username = info.username.trim();
  const userRoot = username ? cleanRemoteDir(`/games/${username}`) : null;

  const candidates = unique([
    // Nitrado DayZ console layouts (PS/Xbox) commonly store DayZServer_*.ADM
    // directly in the config folder beneath game_specific.path.
    gamePath ? joinRemote(gamePath, 'config') : null,
    gamePath ? joinRemote(gamePath, 'logs') : null,
    userRoot ? joinRemote(userRoot, 'dayzstandalone/logs') : null,
    userRoot ? joinRemote(userRoot, 'dayzstandalone/profiles') : null,
    userRoot ? joinRemote(userRoot, 'dayzxb/config') : null,
    userRoot ? joinRemote(userRoot, 'dayzxb/profiles') : null,
    userRoot ? joinRemote(userRoot, 'dayzps/config') : null,
    userRoot ? joinRemote(userRoot, 'dayzps/profiles') : null,
    gamePath ? joinRemote(gamePath, 'profiles') : null,
    gamePath,
  ]);

  let firstExisting: string | null = null;
  for (const candidate of candidates) {
    try {
      const entries = await client.listAdmFiles(scope.nitradoServerId, candidate);
      if (!firstExisting) firstExisting = candidate;
      if (entries.length > 0) {
        return persistResolved(scope, candidate, 'AUTO', existing?.timeZone ?? null);
      }
    } catch {
      // Try next known DayZ layout.
    }
  }

  // Ein vorhandenes, aber leeres Kandidatenverzeichnis darf die echte Suche
  // nicht mehr kurzschliessen. Erst die rekursive Suche nach .ADM versuchen.
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

  // Noch keine ADM-Datei vorhanden, aber mindestens ein plausibles Verzeichnis
  // existiert. Dieses bleibt als Ausgangspunkt erhalten und kann spaeter erneut
  // entdeckt werden; AUTO wird bei jedem Poll auf echte ADM-Dateien geprueft.
  if (firstExisting) {
    return persistResolved(scope, firstExisting, 'AUTO', existing?.timeZone ?? null);
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
  return persistResolved(scope, dir, 'MANUAL', timeZone);
}
