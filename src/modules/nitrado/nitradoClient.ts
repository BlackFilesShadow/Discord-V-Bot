/**
 * Nitrado-API-Client.
 *
 * Doku-Referenzen (Stand 2025): https://doc.nitrado.net/
 *  - GET    /services                          -> alle Services des Tokens
 *  - GET    /services/{id}/gameservers          -> Gameserver-Details
 *  - GET    /services/{id}/gameservers/games/dayz/whitelist -> Whitelist-Liste
 *  - POST   /services/{id}/gameservers/games/dayz/whitelist (identifier=)
 *  - DELETE /services/{id}/gameservers/games/dayz/whitelist (identifier=)
 *  - GET    /services/{id}/gameservers/file_server/list?dir=...
 *  - GET    /services/{id}/gameservers/file_server/download?file=...
 *  - POST   /services/{id}/gameservers/restart
 *
 * Designziele:
 *   - axios-basiert, Bearer-Token im Header
 *   - Retry mit exponentiellem Backoff (3 Versuche, 500/1000/2000ms)
 *   - 429-Handling (Retry-After)
 *   - Fehler werden in `NitradoApiError` gewrapped
 *   - KEIN Logging von Tokens/Headern
 */

import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from 'axios';
import { logger } from '../../utils/logger';

const NITRADO_BASE = 'https://api.nitrado.net';

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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
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
      // Wichtig: NIE Token im Error-Object durchreichen
      validateStatus: () => true,
    });
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, opts: AxiosRequestConfig = {}): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.http.request({ method, url: path, ...opts });
        if (res.status >= 200 && res.status < 300) {
          return res.data as T;
        }
        if (res.status === 429) {
          const retryAfter = Number(res.headers['retry-after']) || 2;
          await sleep(retryAfter * 1000);
          continue;
        }
        if (res.status >= 500 && attempt < 3) {
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
        lastErr = e instanceof Error ? e : new Error(String(e));
        if (attempt < 3 && (e as AxiosError).code !== 'ECONNABORTED') {
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
      }
    }
    throw new NitradoApiError(lastErr?.message ?? 'Unbekannt', null, path);
  }

  /** Pruefung ob Token gueltig ist (lightweight). */
  async validateToken(): Promise<boolean> {
    try {
      await this.request<{ data: { token: { valid: boolean } } }>('GET', '/token');
      return true;
    } catch (e) {
      logger.warn('Nitrado-Token-Validierung fehlgeschlagen:', (e as Error).message);
      return false;
    }
  }

  async listServices(): Promise<NitradoService[]> {
    const res = await this.request<{ data: { services: NitradoService[] } }>('GET', '/services');
    return res.data.services ?? [];
  }

  async getWhitelist(serviceId: string): Promise<NitradoWhitelistEntry[]> {
    const res = await this.request<{ data: { settings: { whitelist?: string } } }>(
      'GET',
      `/services/${serviceId}/gameservers`,
    );
    const raw = res.data?.settings?.whitelist ?? '';
    return raw
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(identifier => ({ identifier }));
  }

  async addToWhitelist(serviceId: string, identifier: string): Promise<void> {
    await this.request<unknown>('POST', `/services/${serviceId}/gameservers/games/dayz/whitelist`, {
      data: new URLSearchParams({ identifier }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  async removeFromWhitelist(serviceId: string, identifier: string): Promise<void> {
    await this.request<unknown>('DELETE', `/services/${serviceId}/gameservers/games/dayz/whitelist`, {
      data: new URLSearchParams({ identifier }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  /** Listet ADM-Files (alle .ADM in /games/<userdir>/dayzxb/profiles/). */
  async listAdmFiles(serviceId: string, profileDir: string): Promise<Array<{ name: string; modified_at: number; size: number }>> {
    const res = await this.request<{ data: { entries: Array<{ name: string; modified_at: number; size: number; type: string }> } }>(
      'GET',
      `/services/${serviceId}/gameservers/file_server/list`,
      { params: { dir: profileDir } },
    );
    return (res.data?.entries ?? [])
      .filter(e => e.type === 'file' && e.name.toLowerCase().endsWith('.adm'))
      .map(({ name, modified_at, size }) => ({ name, modified_at, size }));
  }

  async downloadFile(serviceId: string, fullPath: string): Promise<string> {
    // Nitrado liefert eine signed URL fuer den Download
    const meta = await this.request<{ data: { token: { url: string } } }>(
      'GET',
      `/services/${serviceId}/gameservers/file_server/download`,
      { params: { file: fullPath } },
    );
    const url = meta.data?.token?.url;
    if (!url) throw new NitradoApiError('Keine Download-URL', null, fullPath);
    const res = await axios.get<string>(url, { responseType: 'text', timeout: 30_000 });
    return res.data;
  }

  async restart(serviceId: string, message?: string): Promise<void> {
    await this.request<unknown>('POST', `/services/${serviceId}/gameservers/restart`, {
      data: new URLSearchParams({ message: message ?? 'Restart by V-Bot' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}
