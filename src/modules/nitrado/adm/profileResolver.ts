import prisma from '../../../database/prisma';
import { NitradoClient } from '../nitradoClient';

const VERIFY_CACHE_MS = 10 * 60_000;

type AdmFileListing = Awaited<ReturnType<NitradoClient['listAdmFiles']>>;

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

export type AdmProfileWriteFence = <T>(work: () => Promise<T>) => Promise<T>;

async function runProfileWrite<T>(
  writeFence: AdmProfileWriteFence | undefined,
  work: () => Promise<T>,
): Promise<T> {
  return writeFence ? writeFence(work) : work();
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

async function listAdmFilesSafe(
  client: NitradoClient,
  serviceId: string,
  dir: string,
): Promise<AdmFileListing | null> {
  try {
    return await client.listAdmFiles(serviceId, dir);
  } catch {
    return null;
  }
}

function latestAdmFile(files: AdmFileListing): AdmFileListing[number] | null {
  return [...files]
    .filter(file => Number.isSafeInteger(file.modified_at) && Number.isSafeInteger(file.size) && file.size >= 0)
    .sort((a, b) => b.modified_at - a.modified_at || b.name.localeCompare(a.name))[0] ?? null;
}

async function persistResolved(
  scope: AdmConnectionScope,
  profileDir: string,
  source: string,
  timeZone: string | null,
  writeFence?: AdmProfileWriteFence,
): Promise<ResolvedAdmProfile> {
  const row = await runProfileWrite(writeFence, () => prisma.nitradoAdmProfileConfig.upsert({
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
  }));
  return { profileDir: row.profileDir, timeZone: row.timeZone, source: row.source };
}

export async function recordAdmSourceError(
  scope: { id: string; guildId: string },
  message: string | null,
  writeFence?: AdmProfileWriteFence,
): Promise<void> {
  await runProfileWrite(writeFence, () => prisma.nitradoAdmProfileConfig.updateMany({
    where: { guildId: scope.guildId, nitradoConnId: scope.id },
    data: { lastError: message },
  }));
}

/**
 * Loest das ADM-Verzeichnis strikt pro Nitrado-Connection auf und persistiert
 * es. Manuelle Konfiguration gewinnt. AUTO/AUTO_SEARCH werden sofort neu
 * gesucht, wenn der gespeicherte Pfad keine ADM-Datei mehr enthaelt. Solange
 * dort Dateien liegen, wird der Pfad kurzfristig gecacht; nach VERIFY_CACHE_MS
 * werden jedoch alle bekannten DayZ-Verzeichnisse verglichen und die Quelle mit
 * der frischesten ADM-Datei gewaehlt. Dadurch kann ein alter, weiterhin
 * existierender Log-Ordner die Live-Ingestion nicht dauerhaft stilllegen.
 * Eine globale ENV-Pfadquelle gibt es absichtlich nicht mehr.
 */
export async function resolveAdmProfile(
  scope: AdmConnectionScope,
  client: NitradoClient,
  writeFence?: AdmProfileWriteFence,
): Promise<ResolvedAdmProfile> {
  const existing = await prisma.nitradoAdmProfileConfig.findUnique({
    where: { guildId_nitradoConnId: { guildId: scope.guildId, nitradoConnId: scope.id } },
  });

  const configured = existing ? cleanRemoteDir(existing.profileDir) : null;
  const recentlyVerified = existing?.lastVerifiedAt !== null && existing?.lastVerifiedAt !== undefined
    && Date.now() - existing.lastVerifiedAt.getTime() < VERIFY_CACHE_MS;

  if (existing?.source === 'MANUAL') {
    if (configured && recentlyVerified) {
      return { profileDir: configured, timeZone: existing.timeZone, source: existing.source };
    }
    if (configured && await dirWorks(client, scope.nitradoServerId, configured)) {
      await runProfileWrite(writeFence, () => prisma.nitradoAdmProfileConfig.updateMany({
        where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
        data: { profileDir: configured, lastVerifiedAt: new Date(), lastError: null },
      }));
      return { profileDir: configured, timeZone: existing.timeZone, source: existing.source };
    }
    const message = 'Manuell konfiguriertes ADM-Verzeichnis ist bei Nitrado nicht erreichbar.';
    await runProfileWrite(writeFence, () => prisma.nitradoAdmProfileConfig.updateMany({
      where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
      data: { lastError: message },
    }));
    throw new Error(message);
  }

  // Den aktuell gespeicherten AUTO-Pfad weiterhin bei jedem Poll auf echte
  // ADM-Dateien pruefen. Bei leerem/unerreichbarem Pfad erfolgt sofortige
  // Heilung. Bei einem noch nicht abgelaufenen Freshness-Fenster vermeiden wir
  // dagegen den teuren Vergleich aller bekannten Verzeichnisse.
  const configuredFiles = configured
    ? await listAdmFilesSafe(client, scope.nitradoServerId, configured)
    : null;
  if (configured && configuredFiles && configuredFiles.length > 0 && recentlyVerified) {
    return {
      profileDir: configured,
      timeZone: existing?.timeZone ?? null,
      source: existing?.source ?? 'AUTO',
    };
  }

  const info = await client.getGameserverInfo(scope.nitradoServerId);
  const gamePath = cleanRemoteDir(info.path || '');
  const username = info.username.trim();
  const userRoot = username ? cleanRemoteDir(`/games/${username}`) : null;

  const candidates = unique([
    // Ein bereits automatisch gefundener Custom-Pfad bleibt Kandidat, wird aber
    // nach Ablauf des Freshness-Fensters nicht blind gegen frischere bekannte
    // DayZ-Verzeichnisse bevorzugt.
    configured,
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
  let freshest: { dir: string; file: AdmFileListing[number] } | null = null;
  for (const candidate of candidates) {
    const entries = candidate === configured && configuredFiles !== null
      ? configuredFiles
      : await listAdmFilesSafe(client, scope.nitradoServerId, candidate);
    if (entries === null) continue;
    if (!firstExisting) firstExisting = candidate;
    const latest = latestAdmFile(entries);
    if (!latest) continue;
    if (
      !freshest
      || latest.modified_at > freshest.file.modified_at
      || (latest.modified_at === freshest.file.modified_at && latest.name > freshest.file.name)
    ) {
      freshest = { dir: candidate, file: latest };
    }
  }

  if (freshest) {
    const source = existing && freshest.dir === configured ? existing.source : 'AUTO';
    return persistResolved(scope, freshest.dir, source, existing?.timeZone ?? null, writeFence);
  }

  // Ein vorhandenes, aber leeres Kandidatenverzeichnis darf die echte Suche
  // nicht kurzschliessen. Erst die rekursive Suche nach .ADM versuchen.
  const roots = unique([gamePath, userRoot, '/games']);
  for (const root of roots) {
    try {
      const matches = await client.searchFiles(scope.nitradoServerId, root, '.ADM');
      const sortedMatches = [...matches].sort((a, b) => {
        const aModified = Number.isSafeInteger(a.modified_at) ? a.modified_at : -1;
        const bModified = Number.isSafeInteger(b.modified_at) ? b.modified_at : -1;
        return bModified - aModified || b.name.localeCompare(a.name);
      });
      for (const match of sortedMatches) {
        const location = match.path || match.name;
        if (!location.toLowerCase().includes('.adm')) continue;
        const normalized = cleanRemoteDir(location);
        if (!normalized) continue;
        const slash = normalized.lastIndexOf('/');
        if (slash <= 0) continue;
        const dir = normalized.slice(0, slash);
        if (await dirWorks(client, scope.nitradoServerId, dir)) {
          return persistResolved(scope, dir, 'AUTO_SEARCH', existing?.timeZone ?? null, writeFence);
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
    return persistResolved(scope, firstExisting, 'AUTO', existing?.timeZone ?? null, writeFence);
  }

  const message = 'ADM-Verzeichnis konnte auf diesem Nitrado-Gameserver nicht automatisch gefunden werden.';
  if (existing) {
    await runProfileWrite(writeFence, () => prisma.nitradoAdmProfileConfig.updateMany({
      where: { id: existing.id, guildId: scope.guildId, nitradoConnId: scope.id },
      data: { lastError: message },
    }));
  }
  throw new Error(message);
}

export async function setManualAdmProfile(
  scope: AdmConnectionScope,
  client: NitradoClient,
  profileDir: string,
  timeZone: string | null,
  writeFence?: AdmProfileWriteFence,
): Promise<ResolvedAdmProfile> {
  const dir = cleanRemoteDir(profileDir);
  if (!dir) throw new Error('Ungueltiges ADM-Verzeichnis.');
  if (timeZone && !isValidIanaTimeZone(timeZone)) throw new Error('Ungueltige IANA-Zeitzone.');
  if (!(await dirWorks(client, scope.nitradoServerId, dir))) {
    throw new Error('ADM-Verzeichnis ist bei Nitrado nicht erreichbar.');
  }
  return persistResolved(scope, dir, 'MANUAL', timeZone, writeFence);
}
