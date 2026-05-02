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

import axios, { AxiosError, type AxiosInstance } from 'axios';
import { logger } from '../../../utils/logger';

const NITRADO_BASE = 'https://api.nitrado.net';

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
   * Einziger HTTP-Eintrittspunkt. Hardcoded auf 'GET'. Würde man hier
   * jemals 'method' aufweichen, fängt der Mirror-Safety-Test es.
   */
  private async getJson<T>(path: string, params?: Record<string, string>): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.http.request({ method: 'GET', url: path, params });
        if (res.status >= 200 && res.status < 300) return res.data as T;
        if (res.status === 429) {
          const retry = Number(res.headers['retry-after']) || 2;
          await sleep(retry * 1000);
          continue;
        }
        if (res.status >= 500 && attempt < 3) {
          await sleep(500 * Math.pow(2, attempt - 1));
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
        if (attempt < 3 && (e as AxiosError).code !== 'ECONNABORTED') {
          await sleep(500 * Math.pow(2, attempt - 1));
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
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: 60_000,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
      validateStatus: () => true,
    });
    if (res.status < 200 || res.status >= 300) {
      throw new NitradoReadError(`Download HTTP ${res.status}`, res.status, fullPath);
    }
    return Buffer.from(res.data);
  }
}
