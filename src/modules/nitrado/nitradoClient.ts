/**
 * Nitrado-API-Client.
 *
 * Doku-Referenzen (Stand 2026): https://doc.nitrado.net/
 *  - GET    /services                          -> alle Services des Tokens
 *  - GET    /services/{id}/gameservers          -> Gameserver-Details (data.gameserver.*)
 *  - POST   /services/{id}/gameservers/settings (category, key, value) -> Settings setzen
 *  - GET    /services/{id}/gameservers/file_server/list?dir=...
 *  - GET    /services/{id}/gameservers/file_server/download?file=...
 *  - GET/POST/DELETE /services/{id}/gameservers/games/banlist
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
 * Gameserver-Banlist:
 *   Der offizielle Nitrado-SDK-Vertrag nutzt denselben generischen Endpoint fuer
 *   GET/POST/DELETE und das Form-Feld `identifier`. V-Bot speichert diese
 *   Identifier nicht im Klartext; sie werden nur zur Laufzeit verarbeitet.
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
import { getNitradoBreaker, opClassForMethod, NitradoCircuitOpenError } from './circuitBreaker';

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

export interface NitradoBanlistEntry {
  identifier: string;
  added_at?: string;
}

/**
 * NIT-001: Ergebnis der Token-Pruefung. Ausschliesslich `INVALID` darf zu
 * EXPIRED fuehren; alle anderen Faelle sind transient/diagnostisch.
 */
export type TokenValidationResult =
  | { kind: 'VALID' }
  | { kind: 'INVALID'; status: 401 | 403 | null }
  | { kind: 'RATE_LIMITED' }
  | { kind: 'TRANSIENT_FAILURE'; status?: number; message: string }
  | { kind: 'CIRCUIT_OPEN' };

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// NIT-011: Obergrenze fuer signed-URL-Downloads (ADM-/Log-Dateien).
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/**
 * F-011: Retry-After als Sekunden ODER HTTP-Datum interpretieren, negativ auf 0
 * klemmen und auf capMs deckeln (kein unbegrenztes Warten bei boesartigem Header).
 */
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

/**
 * Normalisiert die `data`-Nutzlast des Nitrado-Banlist-Endpoints.
 * Fail-closed: Ein unbekanntes Format wird NICHT als leere Liste behandelt,
 * weil das bei einem Unban sonst einen noch wirksamen Remote-Bann verbergen
 * koennte.
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
    // NIT-002: Breaker je Operationsklasse (READ/WRITE).
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
          // F-011: Auf dem letzten Versuch den 429-Status erhalten, statt ihn
          // als Unbekannt/null zu verlieren.
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
        breaker.recordFailure();
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
    return (await this.validateTokenDetailed()).kind === 'VALID';
  }

  /**
   * NIT-001: Differenziertes Token-Ergebnis. Nur `INVALID` (401/403 bzw. vom
   * Server als ungueltig gemeldet) rechtfertigt EXPIRED. Transiente Fehler
   * (Netzwerk/429/5xx/Circuit-Open) duerfen einen gueltigen Token NICHT als
   * abgelaufen markieren.
   */
  async validateTokenDetailed(): Promise<TokenValidationResult> {
    try {
      const res = await this.request<{ data?: { token?: { valid?: boolean } } }>('GET', '/token');
      // Ein 2xx auf /token bedeutet: der Token hat sich authentifiziert (ein
      // ungueltiger Token liefert 401 und wirft oben). Nur ein EXPLIZITES
      // valid:false gilt als ungueltig — eine abweichende Antwortstruktur darf
      // einen echten Token NICHT faelschlich ablehnen.
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
   * Offizieller Nitrado-Gameserver-Banlist-Endpoint. Die Antwort wird streng
   * normalisiert; unbekannte Formate werfen statt still `[]` zu liefern.
   */
  async getBanlist(serviceId: string): Promise<NitradoBanlistEntry[]> {
    const path = `/services/${serviceId}/gameservers/games/banlist`;
    const res = await this.request<{ data?: unknown }>('GET', path);
    if (!res || typeof res !== 'object' || !('data' in res)) {
      throw new NitradoApiError('Banlist-Antwort ohne data-Feld', null, path);
    }
    return parseNitradoBanlistData(res.data);
  }

  /** Fuegt einen exakten Gameserver-Identifier zur Nitrado-Banlist hinzu. */
  async addToBanlist(serviceId: string, identifier: string): Promise<void> {
    const id = identifier.trim();
    if (!id) throw new NitradoApiError('Leerer Identifier', null, 'banlist');
    await this.request<unknown>('POST', `/services/${serviceId}/gameservers/games/banlist`, {
      data: new URLSearchParams({ identifier: id }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  /** Entfernt einen exakten Gameserver-Identifier aus der Nitrado-Banlist. */
  async removeFromBanlist(serviceId: string, identifier: string): Promise<void> {
    const id = identifier.trim();
    if (!id) throw new NitradoApiError('Leerer Identifier', null, 'banlist');
    await this.request<unknown>('DELETE', `/services/${serviceId}/gameservers/games/banlist`, {
      data: new URLSearchParams({ identifier: id }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  /**
   * Liefert das aktuelle `whitelist`-Setting als String. Boolean-Defaults werden
   * als leere Liste interpretiert, damit `true` nicht zum Spielernamen wird.
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

  /** Diagnose: rohe Verzeichnisauflistung (Dateien + Ordner) eines Pfads. */
  async listDir(serviceId: string, dir: string): Promise<Array<{ name: string; type: string; modified_at: number; size: number }>> {
    const res = await this.request<{ data: { entries: Array<{ name: string; type: string; modified_at: number; size: number } } }>(
      'GET',
      `/services/${serviceId}/gameservers/file_server/list`,
      { params: { dir } },
    );
    return res.data?.entries ?? [];
  }

  /** Diagnose: ausgewaehlte Gameserver-Stammdaten (game, username, Pfad, Status). */
  async getGameserverInfo(serviceId: string): Promise<{ game: string; username: string; path: string; status: string }> {
    const res = await this.request<{
      data: { gameserver?: { game?: string; username?: string; status?: string; game_specific?: { path?: string } } };
    }>('GET', `/services/${serviceId}/gameservers`);
    const gs = res.data?.gameserver ?? {};
    return {
      game: gs.game ?? '',
      username: gs.username ?? '',
      path: gs.game_specific?.path ?? '',
      status: gs.status ?? 'unknown',
    };
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
    // NIT-011: harte Groessenobergrenze gegen Speicher-Erschoepfung durch
    // ueberraschend grosse ADM-/Log-Dateien.
    const res = await axios.get<string>(url, {
      responseType: 'text',
      timeout: 30_000,
      maxContentLength: MAX_DOWNLOAD_BYTES,
      maxBodyLength: MAX_DOWNLOAD_BYTES,
    });
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
