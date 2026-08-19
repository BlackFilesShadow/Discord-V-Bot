/**
 * Nitrado-API-Client.
 *
 * DayZ-spezifische Leitlinien:
 * - Whitelist und Bannliste werden als Gameserver-Settings unter
 *   `settings.general.whitelist` bzw. `settings.general.bans` verwaltet.
 *   Damit benutzt Ban denselben funktionierenden Read-Modify-Write-Pfad wie
 *   die bereits produktiv bestaetigte Whitelist.
 * - ADM-Dateien werden ueber file_server/list gefunden. Fuer Live-Ingestion
 *   steht zusaetzlich file_server/seek bereit, damit nur neue Bytes gelesen
 *   werden muessen.
 * - Download-/Seek-Tokens werden niemals geloggt.
 */

import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { logger } from '../../utils/logger';
import { getNitradoBreaker, opClassForMethod, NitradoCircuitOpenError } from './circuitBreaker';

const NITRADO_BASE = 'https://api.nitrado.net';
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MAX_SEEK_BYTES = 2 * 1024 * 1024;

export class NitradoApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly endpoint: string,
  ) {
    super(message);
    this.name = 'NitradoApiError';
  }
}

export interface NitradoService {
  id: number;
  type: string;
  status: string;
  details: {
    address?: string;
    name?: string;
    game?: string;
  };
}

export interface NitradoWhitelistEntry {
  identifier: string;
  added_at?: string;
}

export interface NitradoBanlistEntry {
  identifier: string;
  added_at?: string;
}

export interface NitradoFileEntry {
  name: string;
  type: string;
  modified_at: number;
  size: number;
  path?: string;
}

export type TokenValidationResult =
  | { kind: 'VALID' }
  | { kind: 'INVALID'; status: 401 | 403 | null }
  | { kind: 'RATE_LIMITED' }
  | { kind: 'TRANSIENT_FAILURE'; status?: number; message: string }
  | { kind: 'CIRCUIT_OPEN' };

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export function parseRetryAfterMs(header: unknown, capMs = 30_000): number {
  if (header == null) return 2000;
  const raw = String(Array.isArray(header) ? header[0] : header).trim();
  if (raw === '') return 2000;
  const asSeconds = Number(raw);
  let ms: number;
  if (Number.isFinite(asSeconds)) {
    ms = asSeconds * 1000;
  } else {
    const at = Date.parse(raw);
    ms = Number.isNaN(at) ? 2000 : at - Date.now();
  }
  if (ms < 0) ms = 0;
  return Math.min(ms, capMs);
}

function parseLines(raw: string): string[] {
  return raw
    .split(/\r\n|\n|\r/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * Kompatibilitaetsparser fuer den generischen Nitrado-Banlist-Endpoint.
 * Der produktive DayZ-Pfad verwendet `settings.general.bans`; dieser Parser
 * bleibt fuer Diagnose/Regression erhalten und akzeptiert sowohl den alten
 * `identifier`-Vertrag als auch das dokumentierte Player-Management-Format
 * `{ name, id, id_type }`.
 */
export function parseNitradoBanlistData(data: unknown): NitradoBanlistEntry[] {
  let rawEntries: unknown[];
  if (Array.isArray(data)) {
    rawEntries = data;
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    const candidate = obj.banlist ?? obj.bans ?? obj.entries;
    if (!Array.isArray(candidate)) {
      throw new NitradoApiError('Unbekanntes Banlist-Antwortformat', null, 'banlist');
    }
    rawEntries = candidate;
  } else {
    throw new NitradoApiError('Unbekanntes Banlist-Antwortformat', null, 'banlist');
  }

  const out: NitradoBanlistEntry[] = [];
  const seen = new Set<string>();
  for (const raw of rawEntries) {
    let identifier = '';
    let addedAt: string | undefined;
    if (typeof raw === 'string') {
      identifier = raw.trim();
    } else if (raw && typeof raw === 'object') {
      const row = raw as Record<string, unknown>;
      if (typeof row.identifier === 'string') identifier = row.identifier.trim();
      else if (typeof row.id === 'string') identifier = row.id.trim();
      else if (typeof row.name === 'string') identifier = row.name.trim();
      if (typeof row.added_at === 'string') addedAt = row.added_at;
    }
    if (!identifier) {
      throw new NitradoApiError('Ungueltiger Banlist-Eintrag ohne Identifier', null, 'banlist');
    }
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    out.push(addedAt ? { identifier, added_at: addedAt } : { identifier });
  }
  return out;
}

interface SignedFileToken {
  url: string;
  token?: string;
}

function axiosStatus(error: unknown): number | null {
  const status = (error as AxiosError)?.response?.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

function axiosRetryAfter(error: unknown): unknown {
  return (error as AxiosError)?.response?.headers?.['retry-after'];
}

export class NitradoClient {
  private readonly http: AxiosInstance;

  constructor(rawToken: string) {
    if (!rawToken || rawToken.length < 8) throw new Error('Nitrado-Token leer/zu kurz');
    this.http = axios.create({
      baseURL: NITRADO_BASE,
      timeout: 15_000,
      headers: {
        Authorization: `Bearer ${rawToken}`,
        Accept: 'application/json',
      },
      validateStatus: () => true,
    });
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: AxiosRequestConfig = {}): Promise<T> {
    const breaker = getNitradoBreaker(opClassForMethod(method));
    breaker.preflight();

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.http.request({ method, url: path, ...opts });
        if (res.status >= 200 && res.status < 300) {
          breaker.recordSuccess();
          return res.data as T;
        }
        if (res.status === 429) {
          breaker.recordFailure();
          if (attempt >= 3) {
            throw new NitradoApiError('Rate-Limit (429) nach mehreren Versuchen', 429, path);
          }
          await sleep(parseRetryAfterMs(res.headers['retry-after']));
          continue;
        }
        if (res.status >= 500 && attempt < 3) {
          breaker.recordFailure();
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
        throw new NitradoApiError(
          typeof res.data === 'object' && res.data?.message ? res.data.message : `HTTP ${res.status}`,
          res.status,
          path,
        );
      } catch (e) {
        if (e instanceof NitradoApiError) throw e;
        if (e instanceof NitradoCircuitOpenError) throw e;
        lastErr = e instanceof Error ? e : new Error(String(e));
        breaker.recordFailure();
        // Nitrado-1V: Timeout (ECONNABORTED) ist genau wie andere Transportfehler
        // transient. Ein einzelner 15s-Timeout darf weder READ noch WRITE sofort
        // terminalisieren; alle Transportfehler bleiben auf drei Versuche begrenzt.
        if (attempt < 3) {
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
      }
    }
    throw new NitradoApiError(lastErr?.message ?? 'Unbekannt', null, path);
  }

  async validateToken(): Promise<boolean> {
    return (await this.validateTokenDetailed()).kind === 'VALID';
  }

  async validateTokenDetailed(): Promise<TokenValidationResult> {
    try {
      const res = await this.request<{ data?: { token?: { valid?: boolean } } }>('GET', '/token');
      return res.data?.token?.valid === false ? { kind: 'INVALID', status: null } : { kind: 'VALID' };
    } catch (e) {
      if (e instanceof NitradoCircuitOpenError) return { kind: 'CIRCUIT_OPEN' };
      if (e instanceof NitradoApiError) {
        if (e.status === 401 || e.status === 403) return { kind: 'INVALID', status: e.status };
        if (e.status === 429) return { kind: 'RATE_LIMITED' };
        return { kind: 'TRANSIENT_FAILURE', status: e.status ?? undefined, message: e.message };
      }
      logger.warn('Nitrado-Token-Validierung fehlgeschlagen:', (e as Error).message);
      return { kind: 'TRANSIENT_FAILURE', message: (e as Error).message };
    }
  }

  async listServices(): Promise<NitradoService[]> {
    const res = await this.request<{ data: { services: NitradoService[] } }>('GET', '/services');
    return res.data.services ?? [];
  }

  private async getGeneralSetting(serviceId: string, key: string): Promise<string> {
    const res = await this.request<{
      data: { gameserver?: { settings?: { general?: Record<string, unknown> } } };
    }>('GET', `/services/${serviceId}/gameservers`);
    const value = res.data?.gameserver?.settings?.general?.[key];
    if (typeof value !== 'string') return '';
    if (value === 'true' || value === 'false') return '';
    return value;
  }

  private async setSetting(serviceId: string, category: string, key: string, value: string): Promise<void> {
    await this.request<unknown>('POST', `/services/${serviceId}/gameservers/settings`, {
      data: new URLSearchParams({ category, key, value }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  private async mutateGeneralList(
    serviceId: string,
    key: 'whitelist' | 'bans',
    mutator: (current: string[]) => string[],
  ): Promise<boolean> {
    const current = parseLines(await this.getGeneralSetting(serviceId, key));
    const next = dedupe(mutator(current).map(s => s.trim()).filter(Boolean));
    if (current.length === next.length && current.every((value, index) => value === next[index])) return false;
    await this.setSetting(serviceId, 'general', key, next.join('\r\n'));
    return true;
  }

  async getWhitelist(serviceId: string): Promise<NitradoWhitelistEntry[]> {
    return parseLines(await this.getGeneralSetting(serviceId, 'whitelist')).map(identifier => ({ identifier }));
  }

  async addToWhitelist(serviceId: string, identifier: string): Promise<void> {
    const id = identifier.trim();
    if (!id) throw new NitradoApiError('Leerer Identifier', null, 'whitelist');
    await this.mutateGeneralList(serviceId, 'whitelist', list => list.includes(id) ? list : [...list, id]);
  }

  async removeFromWhitelist(serviceId: string, identifier: string): Promise<void> {
    const id = identifier.trim();
    if (!id) throw new NitradoApiError('Leerer Identifier', null, 'whitelist');
    await this.mutateGeneralList(serviceId, 'whitelist', list => list.filter(entry => entry !== id));
  }

  /** DayZ-Bannliste aus demselben Settings-Pfad wie die funktionierende Whitelist. */
  async getBanlist(serviceId: string): Promise<NitradoBanlistEntry[]> {
    return parseLines(await this.getGeneralSetting(serviceId, 'bans')).map(identifier => ({ identifier }));
  }

  async addToBanlist(serviceId: string, identifier: string): Promise<void> {
    const id = identifier.trim();
    if (!id) throw new NitradoApiError('Leerer Identifier', null, 'banlist');
    await this.mutateGeneralList(serviceId, 'bans', list => list.includes(id) ? list : [...list, id]);
  }

  async removeFromBanlist(serviceId: string, identifier: string): Promise<void> {
    const id = identifier.trim();
    if (!id) throw new NitradoApiError('Leerer Identifier', null, 'banlist');
    await this.mutateGeneralList(serviceId, 'bans', list => list.filter(entry => entry !== id));
  }

  async listAdmFiles(serviceId: string, profileDir: string): Promise<Array<{ name: string; modified_at: number; size: number }>> {
    const entries = await this.listDir(serviceId, profileDir);
    return entries
      .filter(entry => entry.type === 'file' && entry.name.toLowerCase().endsWith('.adm'))
      .map(({ name, modified_at, size }) => ({ name, modified_at, size }));
  }

  async listDir(serviceId: string, dir: string): Promise<NitradoFileEntry[]> {
    const res = await this.request<{ data: { entries?: NitradoFileEntry[] } }>(
      'GET',
      `/services/${serviceId}/gameservers/file_server/list`,
      { params: { dir } },
    );
    return res.data?.entries ?? [];
  }

  /** Rekursive Dateisuche, wie vom offiziellen Nitrado FileServer-Client angeboten. */
  async searchFiles(serviceId: string, dir: string, search: string): Promise<NitradoFileEntry[]> {
    const res = await this.request<{ data: { entries?: NitradoFileEntry[] } }>(
      'GET',
      `/services/${serviceId}/gameservers/file_server/list`,
      { params: { dir, search } },
    );
    return res.data?.entries ?? [];
  }

  async getGameserverInfo(serviceId: string): Promise<{ game: string; username: string; path: string; status: string }> {
    const res = await this.request<{
      data: { gameserver?: { game?: string; username?: string; status?: string; game_specific?: { path?: string } } };
    }>('GET', `/services/${serviceId}/gameservers`);
    const gameserver = res.data?.gameserver ?? {};
    return {
      game: gameserver.game ?? '',
      username: gameserver.username ?? '',
      path: gameserver.game_specific?.path ?? '',
      status: gameserver.status ?? 'unknown',
    };
  }

  private async fetchSignedText(meta: SignedFileToken, maxBytes: number): Promise<string> {
    if (!meta.url) throw new NitradoApiError('Keine Download-URL', null, 'file_server');

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await axios.get<string>(meta.url, {
          responseType: 'text',
          timeout: 30_000,
          params: meta.token ? { token: meta.token } : undefined,
          maxContentLength: maxBytes,
          maxBodyLength: maxBytes,
        });
        return res.data;
      } catch (e) {
        const status = axiosStatus(e);
        lastErr = e instanceof Error ? e : new Error(String(e));

        if (status === 429) {
          if (attempt >= 3) {
            throw new NitradoApiError('Signed Download Rate-Limit (429) nach mehreren Versuchen', 429, 'file_server');
          }
          await sleep(parseRetryAfterMs(axiosRetryAfter(e)));
          continue;
        }

        if (status !== null) {
          if (status >= 500 && attempt < 3) {
            await sleep(500 * Math.pow(2, attempt - 1));
            continue;
          }
          throw new NitradoApiError(lastErr.message || `HTTP ${status}`, status, 'file_server');
        }

        // Signierte Downloads/Seek-Hops sind ein eigener HTTP-Hop. Auch hier
        // duerfen Timeout/Transportfehler nicht nach dem ersten Versuch die
        // ADM-/Mirror-Verarbeitung abbrechen; die Retry-Grenze bleibt bounded.
        if (attempt < 3) {
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
      }
    }

    throw new NitradoApiError(lastErr?.message ?? 'Signed Download fehlgeschlagen', null, 'file_server');
  }

  async downloadFile(serviceId: string, fullPath: string): Promise<string> {
    const meta = await this.request<{ data: { token?: SignedFileToken } }>(
      'GET',
      `/services/${serviceId}/gameservers/file_server/download`,
      { params: { file: fullPath } },
    );
    const token = meta.data?.token;
    if (!token?.url) throw new NitradoApiError('Keine Download-URL', null, fullPath);
    return this.fetchSignedText(token, MAX_DOWNLOAD_BYTES);
  }

  /**
   * Liest einen Byte-Bereich einer Datei ueber file_server/seek. Das ist der
   * produktive Live-ADM-Pfad und verhindert wiederholte Voll-Downloads.
   */
  async downloadFileRange(serviceId: string, fullPath: string, offset: number, length: number): Promise<string> {
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new NitradoApiError('Ungueltiger Datei-Offset', null, fullPath);
    }
    if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_SEEK_BYTES) {
      throw new NitradoApiError('Ungueltige Seek-Laenge', null, fullPath);
    }
    const meta = await this.request<{ data: { token?: SignedFileToken } }>(
      'GET',
      `/services/${serviceId}/gameservers/file_server/seek`,
      { params: { file: fullPath, offset, length, mode: 'raw' } },
    );
    const token = meta.data?.token;
    if (!token?.url) throw new NitradoApiError('Keine Seek-URL', null, fullPath);
    return this.fetchSignedText(token, Math.min(length + 4096, MAX_SEEK_BYTES));
  }

  async restart(serviceId: string, message?: string): Promise<void> {
    await this.request<unknown>('POST', `/services/${serviceId}/gameservers/restart`, {
      data: new URLSearchParams({ message: message ?? 'Restart by V-Bot' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async getServiceStatus(serviceId: string): Promise<string> {
    const res = await this.request<{
      data: { gameserver?: { status?: string; query?: { server_state?: string } } };
    }>('GET', `/services/${serviceId}/gameservers`);
    const gameserver = res.data?.gameserver;
    return (gameserver?.query?.server_state || gameserver?.status || 'unknown').toLowerCase();
  }

  async start(serviceId: string, message?: string): Promise<void> {
    await this.request<unknown>('POST', `/services/${serviceId}/gameservers/restart`, {
      data: new URLSearchParams({ message: message ?? 'Auto-Start by V-Bot (PermaOnly)' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}
