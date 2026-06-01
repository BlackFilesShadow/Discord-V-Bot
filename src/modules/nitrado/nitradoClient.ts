/**
 * Nitrado-API-Client.
 *
 * Doku-Referenzen (Stand 2026): https://doc.nitrado.net/
 *  - GET    /services                          -> alle Services des Tokens
 *  - GET    /services/{id}/gameservers          -> Gameserver-Details (data.gameserver.*)
 *  - POST   /services/{id}/gameservers/settings (category, key, value) -> Settings setzen
 *  - GET    /services/{id}/gameservers/file_server/list?dir=...
 *  - GET    /services/{id}/gameservers/file_server/download?file=...
 *  - POST   /services/{id}/gameservers/restart
 *
 * DayZ-Whitelist:
 *   Es gibt KEINEN dedizierten REST-Endpoint /games/dayz/whitelist (404).
 *   DayZ-Server haben in `data.gameserver.settings.general` ZWEI separate Felder:
 *     - `whitelist`  -> Hard-Whitelist (wer ueberhaupt joinen darf), Newline-Liste
 *     - `priority`   -> Priority-Queue (reservierte Slots wenn voll), Newline-Liste
 *   Wir nutzen ausschliesslich `whitelist`. Aenderungen via Read-Modify-Write
 *   ueber POST /services/{id}/gameservers/settings (category=general,
 *   key=whitelist, value=<\r\n-Liste>).
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
import { nitradoBreaker, NitradoCircuitOpenError } from './circuitBreaker';

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

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const it of items) {
    if (!seen.has(it)) { seen.add(it); out.push(it); }
  }
  return out;
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
    // P0-Hardening: Circuit-Breaker-Preflight. Wirft NitradoCircuitOpenError
    // wenn API als down markiert ist — verhindert Thundering-Herd.
    nitradoBreaker.preflight();

    let lastErr: Error | null = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await this.http.request({ method, url: path, ...opts });
        if (res.status >= 200 && res.status < 300) {
          nitradoBreaker.recordSuccess();
          return res.data as T;
        }
        if (res.status === 429) {
          nitradoBreaker.recordFailure();
          const retryAfter = Number(res.headers['retry-after']) || 2;
          await sleep(retryAfter * 1000);
          continue;
        }
        if (res.status >= 500 && attempt < 3) {
          nitradoBreaker.recordFailure();
          await sleep(500 * Math.pow(2, attempt - 1));
          continue;
        }
        // 4xx (ausser 429) sind Client-Fehler — Circuit NICHT kippen.
        throw new NitradoApiError(
          typeof res.data === 'object' && res.data?.message ? res.data.message : `HTTP ${res.status}`,
          res.status,
          path,
        );
      } catch (e) {
        if (e instanceof NitradoApiError) throw e;
        if (e instanceof NitradoCircuitOpenError) throw e;
        lastErr = e instanceof Error ? e : new Error(String(e));
        // Netzwerk-/Timeout-Fehler: zaehlt als Server-seitig.
        nitradoBreaker.recordFailure();
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
      const res = await this.request<{ data: { token?: { valid?: boolean } } }>('GET', '/token');
      return res.data?.token?.valid === true;
    } catch (e) {
      logger.warn('Nitrado-Token-Validierung fehlgeschlagen:', (e as Error).message);
      return false;
    }
  }

  async listServices(): Promise<NitradoService[]> {
    const res = await this.request<{ data: { services: NitradoService[] } }>('GET', '/services');
    return res.data.services ?? [];
  }

  /**
   * Liest das `whitelist`-Setting (Hard-Whitelist) aus den DayZ-Server-Settings.
   * Liefert eine entduplizierte, getrimmte Liste der Spielernamen.
   */
  async getWhitelist(serviceId: string): Promise<NitradoWhitelistEntry[]> {
    const raw = await this.getWhitelistSetting(serviceId);
    return parseLines(raw).map(identifier => ({ identifier }));
  }

  /**
   * Atomarer Read-Modify-Write der DayZ-Whitelist.
   * `mutator` erhaelt die aktuelle Liste und gibt die neue zurueck.
   * Liefert true, wenn ein Schreibzugriff stattgefunden hat.
   */
  private async mutateWhitelist(
    serviceId: string,
    mutator: (current: string[]) => string[],
  ): Promise<boolean> {
    const current = parseLines(await this.getWhitelistSetting(serviceId));
    const next = dedupe(mutator(current).map(s => s.trim()).filter(s => s.length > 0));
    if (current.length === next.length && current.every((v, i) => v === next[i])) return false;
    await this.setSetting(serviceId, 'general', 'whitelist', next.join('\r\n'));
    return true;
  }

  async addToWhitelist(serviceId: string, identifier: string): Promise<void> {
    const id = identifier.trim();
    if (!id) throw new NitradoApiError('Leerer Identifier', null, 'whitelist');
    await this.mutateWhitelist(serviceId, list =>
      list.includes(id) ? list : [...list, id],
    );
  }

  async removeFromWhitelist(serviceId: string, identifier: string): Promise<void> {
    const id = identifier.trim();
    if (!id) throw new NitradoApiError('Leerer Identifier', null, 'whitelist');
    await this.mutateWhitelist(serviceId, list => list.filter(e => e !== id));
  }

  /**
   * Liefert den aktuellen `whitelist`-String (newline-separiert) oder ''.
   * Hinweis: Bei jungfraeulichen Servern kann das Feld den Default-Wert
   * 'true'/'false' (Boolean-Toggle) statt einer Liste enthalten — den
   * filtern wir hier raus, damit aus 'true' kein Whitelist-Eintrag wird.
   */
  private async getWhitelistSetting(serviceId: string): Promise<string> {
    const res = await this.request<{ data: { gameserver?: { settings?: { general?: Record<string, string> } } } }>(
      'GET',
      `/services/${serviceId}/gameservers`,
    );
    const v = res.data?.gameserver?.settings?.general?.whitelist ?? '';
    if (v === 'true' || v === 'false') return '';
    return v;
  }

  /**
   * Setzt eine einzelne Server-Setting.
   * Endpoint laut Nitrado: POST /services/{id}/gameservers/settings
   * Body (form-urlencoded): category, key, value
   */
  private async setSetting(serviceId: string, category: string, key: string, value: string): Promise<void> {
    await this.request<unknown>('POST', `/services/${serviceId}/gameservers/settings`, {
      data: new URLSearchParams({ category, key, value }).toString(),
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

  /**
   * Liefert den aktuellen Server-Status (Nitrado: `query.server_state` oder
   * top-level `status`). Werte typischerweise: 'started', 'stopped',
   * 'restarting', 'stopping', 'installing', 'updating', 'suspended'.
   * Liefert 'unknown' wenn die API kein verwertbares Feld liefert.
   */
  async getServiceStatus(serviceId: string): Promise<string> {
    const res = await this.request<{
      data: {
        gameserver?: {
          status?: string;
          query?: { server_state?: string };
        };
      };
    }>('GET', `/services/${serviceId}/gameservers`);
    const gs = res.data?.gameserver;
    return (gs?.query?.server_state || gs?.status || 'unknown').toLowerCase();
  }

  /**
   * Startet einen gestoppten Server. Nitrado-API hat keinen dedizierten
   * Start-Endpoint — der Restart-Endpoint funktioniert auch fuer den Cold-Start
   * (Server-State wechselt von 'stopped' zu 'restarting' -> 'started').
   */
  async start(serviceId: string, message?: string): Promise<void> {
    await this.request<unknown>('POST', `/services/${serviceId}/gameservers/restart`, {
      data: new URLSearchParams({ message: message ?? 'Auto-Start by V-Bot (PermaOnly)' }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }
}
