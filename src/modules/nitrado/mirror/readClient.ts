/**
 * NitradoReadClient — STRIKT READ-ONLY.
 *
 * SICHERHEITS-INVARIANTE (Build wird per Test gegen Verstöße abgesichert,
 * siehe tests/security/nitradoMirrorReadOnly.test.ts):
 *   - Diese Datei darf NUR HTTP-GET-Aufrufe machen.
 *   - Kein POST/PUT/PATCH/DELETE.
 *   - Keine Importe aus Modulen die schreibende Operationen anbieten
 *     (z.B. NitradoClient.setSetting / mutateWhitelist / restart).
 *
 * Zweck: einmaliger Voll-Spiegel der Nitrado-Server-Daten in den Mirror.
 * Es darf NICHTS am Nitrado-Server verändert, verschoben oder gelöscht werden.
 */

import axios, { type AxiosInstance } from 'axios';
import { logger } from '../../../utils/logger';

const NITRADO_BASE = 'https://api.nitrado.net';
const MAX_ATTEMPTS = 3;
const RETRY_AFTER_DEFAULT_MS = 2_000;
const RETRY_AFTER_CAP_MS = 30_000;
const RETRY_BACKOFF_BASE_MS = 500;

export class NitradoReadError extends Error {
  constructor(message: string, public readonly status: number | null, public readonly endpoint: string) {
    super(message);
    this.name = 'NitradoReadError';
  }
}

export interface FileEntry {
  name: string;
  type: 'file' | 'dir';
  size: number;
  modified_at: number; // unix seconds
  owner?: string;
  chmod?: string;
  path: string; // absoluter Pfad (Nitrado liefert das mit)
}

export interface ServiceMeta {
  id: number;
  type: string;
  status: string;
  details?: { address?: string; name?: string; game?: string };
  [k: string]: unknown;
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

function retryBackoffMs(attempt: number): number {
  return RETRY_BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
}

/**
 * Nitrado-1L: Retry-After muss dieselbe bounded Semantik wie der kanonische
 * NitradoClient besitzen. Sekunden und HTTP-Datum werden akzeptiert; kaputte
 * oder fehlende Header fallen auf einen kleinen Default zurueck und kein
 * Remote-Header darf den Mirror minuten-/stundenlang blockieren.
 */
export function parseMirrorRetryAfterMs(header: unknown, capMs = RETRY_AFTER_CAP_MS): number {
  if (header == null) return Math.min(RETRY_AFTER_DEFAULT_MS, Math.max(0, capMs));
  const raw = String(Array.isArray(header) ? header[0] : header).trim();
  if (raw === '') return Math.min(RETRY_AFTER_DEFAULT_MS, Math.max(0, capMs));

  const asSeconds = Number(raw);
  let ms: number;
  if (Number.isFinite(asSeconds)) {
    ms = asSeconds * 1000;
  } else {
    const at = Date.parse(raw);
    ms = Number.isNaN(at) ? RETRY_AFTER_DEFAULT_MS : at - Date.now();
  }

  if (ms < 0) ms = 0;
  return Math.min(ms, Math.max(0, capMs));
}

export class NitradoReadClient {
  private readonly http: AxiosInstance;

  constructor(rawToken: string) {
    if (!rawToken || rawToken.length < 8) throw new Error('Nitrado-Token leer/zu kurz');
    this.http = axios.create({
      baseURL: NITRADO_BASE,
      timeout: 20_000,
      headers: { Authorization: `Bearer ${rawToken}`, Accept: 'application/json' },
      validateStatus: () => true,
    });
  }

  /**
   * Einziger API-HTTP-Eintrittspunkt. Hardcoded auf 'GET'. Würde man hier
   * jemals 'method' aufweichen, fängt der Mirror-Safety-Test es.
   *
   * Nitrado-1L:
   * - 429 behaelt nach dem letzten Versuch seinen echten Status.
   * - 5xx und Transport-/Timeoutfehler werden bounded erneut versucht.
   * - 4xx ausser 429 werden ohne sinnlosen Retry sofort weitergereicht.
   */
  private async getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.http.request({ method: 'GET', url: path, params });
        if (res.status >= 200 && res.status < 300) return res.data as T;

        if (res.status === 429) {
          if (attempt >= MAX_ATTEMPTS) {
            throw new NitradoReadError('Rate-Limit (429) nach mehreren Versuchen', 429, path);
          }
          await sleep(parseMirrorRetryAfterMs(res.headers['retry-after']));
          continue;
        }

        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          await sleep(retryBackoffMs(attempt));
          continue;
        }

        throw new NitradoReadError(
          typeof res.data === 'object' && (res.data as { message?: string })?.message
            ? (res.data as { message: string }).message
            : `HTTP ${res.status}`,
          res.status,
          path,
        );
      } catch (e) {
        if (e instanceof NitradoReadError) throw e;
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_ATTEMPTS) {
          await sleep(retryBackoffMs(attempt));
          continue;
        }
      }
    }
    throw new NitradoReadError(lastErr?.message ?? 'Unbekannt', null, path);
  }

  async validateToken(): Promise<boolean> {
    try {
      await this.getJson<{ data: { token: { valid: boolean } } }>('/token');
      return true;
    } catch (e) {
      logger.warn('[NitradoMirror] Token-Validierung fehlgeschlagen:', (e as Error).message);
      return false;
    }
  }

  async listServices(): Promise<ServiceMeta[]> {
    const res = await this.getJson<{ data: { services: ServiceMeta[] } }>('/services');
    return res.data.services ?? [];
  }

  async getServiceMeta(serviceId: string): Promise<ServiceMeta | null> {
    const list = await this.listServices();
    return list.find(s => String(s.id) === String(serviceId)) ?? null;
  }

  /** Komplettes Gameserver-Detail-Objekt (Settings, Status, Mods, Admins, Backups …). */
  async getGameserver(serviceId: string): Promise<unknown> {
    const res = await this.getJson<{ data: unknown }>(`/services/${serviceId}/gameservers`);
    return res.data;
  }

  /** Verzeichnis-Listing (1 Ebene). */
  async listDir(serviceId: string, dir: string): Promise<FileEntry[]> {
    const res = await this.getJson<{ data: { entries: Array<Partial<FileEntry> & { name: string; type: string; size?: number; modified_at?: number; path?: string }> } }>(
      `/services/${serviceId}/gameservers/file_server/list`,
      { dir },
    );
    const entries = res.data?.entries ?? [];
    return entries
      .filter(e => e.type === 'file' || e.type === 'dir')
      .map(e => ({
        name: e.name,
        type: e.type as 'file' | 'dir',
        size: Number(e.size ?? 0),
        modified_at: Number(e.modified_at ?? 0),
        owner: (e as { owner?: string }).owner,
        chmod: (e as { chmod?: string }).chmod,
        path: e.path ?? `${dir.replace(/\/$/, '')}/${e.name}`,
      }));
  }

  /**
   * Auch der zweite, signierte Download-Hop ist Teil der Nitrado-Read-Kette.
   * Er bekommt deshalb dieselbe bounded 429/5xx/Transport-Semantik wie die
   * API-GETs, ohne die Read-Only-Grenze aufzuweichen.
   */
  private async downloadSignedBuffer(url: string, fullPath: string, maxBytes: number): Promise<Buffer> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await axios.get<ArrayBuffer>(url, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          maxContentLength: maxBytes,
          maxBodyLength: maxBytes,
          validateStatus: () => true,
        });

        if (res.status >= 200 && res.status < 300) return Buffer.from(res.data);

        if (res.status === 429) {
          if (attempt >= MAX_ATTEMPTS) {
            throw new NitradoReadError('Download Rate-Limit (429) nach mehreren Versuchen', 429, fullPath);
          }
          await sleep(parseMirrorRetryAfterMs(res.headers['retry-after']));
          continue;
        }

        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          await sleep(retryBackoffMs(attempt));
          continue;
        }

        throw new NitradoReadError(`Download HTTP ${res.status}`, res.status, fullPath);
      } catch (e) {
        if (e instanceof NitradoReadError) throw e;
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (attempt < MAX_ATTEMPTS) {
          await sleep(retryBackoffMs(attempt));
          continue;
        }
      }
    }

    throw new NitradoReadError(lastErr?.message ?? 'Download fehlgeschlagen', null, fullPath);
  }

  /**
   * Erzeugt eine signierte Download-URL und lädt den Inhalt als Buffer.
   * Wichtig: responseType='arraybuffer' damit Binärdateien nicht korrumpiert werden.
   */
  async downloadFile(serviceId: string, fullPath: string, maxBytes: number): Promise<Buffer> {
    const meta = await this.getJson<{ data: { token: { url: string } } }>(
      `/services/${serviceId}/gameservers/file_server/download`,
      { file: fullPath },
    );
    const url = meta.data?.token?.url;
    if (!url) throw new NitradoReadError('Keine Download-URL', null, fullPath);
    return this.downloadSignedBuffer(url, fullPath, maxBytes);
  }
}
