/**
 * Discord-Konfigurations-Diagnose.
 *
 * GET /api/health/discord
 * Prueft ohne Geheimnisse zurueckzugeben:
 *  1. Bot-Token gueltig (https://discord.com/api/v10/users/@me als Bot)
 *  2. Application-Daten lesbar (Client-ID korrekt; flags fuer privileged intents)
 *  3. Intents im Code-Bedarf gegen Application-Flags
 *  4. OAuth-Redirect-URI Plausibilitaet (https-Pflicht ausser localhost,
 *     Schema-Match zwischen DASHBOARD_URL und OAUTH2_REDIRECT_URI)
 *  5. Bot-Gateway verbunden (client.ws.status === Ready)
 *
 * Antwort:
 *   { ok: boolean, checks: [{ id, label, status, hint?, detail? }] }
 *
 * status ∈ 'pass' | 'warn' | 'fail'
 *
 * Endpoint ist absichtlich nicht hinter requireAuth — er gibt KEINE Secrets
 * zurueck und ist fuer Owner-Self-Service-Setup wichtig (DM-Link anklicken,
 * sehen was fehlt).
 */

import { Router } from 'express';
import axios from 'axios';
import { config } from '../../config';
import { tryGetDashboardClient } from '../clientRegistry';
import { logger } from '../../utils/logger';

export const discordHealthRouter = Router();

interface Check {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail';
  hint?: string;
  detail?: string;
}

// Discord Application Flag Bits (https://discord.com/developers/docs/resources/application#application-object-application-flags)
const FLAG_GATEWAY_PRESENCE = 1 << 12;
const FLAG_GATEWAY_PRESENCE_LIMITED = 1 << 13;
const FLAG_GATEWAY_GUILD_MEMBERS = 1 << 14;
const FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
const FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

interface MeResponse { id: string; username: string; bot?: boolean }
interface AppResponse { id: string; flags?: number; name?: string; bot_public?: boolean; bot_require_code_grant?: boolean }

async function fetchBotMe(): Promise<{ ok: true; data: MeResponse } | { ok: false; status: number; message: string }> {
  try {
    const res = await axios.get<MeResponse>('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${config.discord.token}` },
      timeout: 5000,
      validateStatus: () => true,
    });
    if (res.status === 200) return { ok: true, data: res.data };
    return { ok: false, status: res.status, message: typeof res.data === 'object' && res.data && 'message' in res.data ? String((res.data as { message: unknown }).message) : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, message: (e as Error).message };
  }
}

async function fetchApplication(): Promise<{ ok: true; data: AppResponse } | { ok: false; status: number; message: string }> {
  try {
    const res = await axios.get<AppResponse>('https://discord.com/api/v10/applications/@me', {
      headers: { Authorization: `Bot ${config.discord.token}` },
      timeout: 5000,
      validateStatus: () => true,
    });
    if (res.status === 200) return { ok: true, data: res.data };
    return { ok: false, status: res.status, message: typeof res.data === 'object' && res.data && 'message' in res.data ? String((res.data as { message: unknown }).message) : `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, status: 0, message: (e as Error).message };
  }
}

discordHealthRouter.get('/discord', async (_req, res) => {
  const checks: Check[] = [];

  // 1) Bot-Token
  const me = await fetchBotMe();
  if (me.ok) {
    checks.push({
      id: 'bot.token', label: 'Bot-Token gueltig', status: 'pass',
      detail: `Authentifiziert als ${me.data.username} (${me.data.id})`,
    });
  } else {
    checks.push({
      id: 'bot.token', label: 'Bot-Token gueltig', status: 'fail',
      hint: 'Im Developer Portal unter Bot -> Token neu generieren und in .env als DISCORD_TOKEN setzen.',
      detail: `Discord-API: ${me.message}`,
    });
  }

  // 2) Application + Client-ID-Match
  const app = await fetchApplication();
  if (app.ok) {
    if (app.data.id === config.discord.clientId) {
      checks.push({
        id: 'app.clientId', label: 'DISCORD_CLIENT_ID stimmt mit Token-App ueberein', status: 'pass',
        detail: `App "${app.data.name ?? app.data.id}"`,
      });
    } else {
      checks.push({
        id: 'app.clientId', label: 'DISCORD_CLIENT_ID stimmt mit Token-App ueberein', status: 'fail',
        hint: 'Token gehoert zu einer anderen Application. .env DISCORD_CLIENT_ID korrigieren.',
        detail: `Token-App-ID=${app.data.id}, .env=${config.discord.clientId}`,
      });
    }

    // 3) Privileged Intents
    const flags = app.data.flags ?? 0;
    const intentChecks: Array<{ name: string; bits: number; needed: boolean }> = [
      { name: 'GuildPresences (PRESENCE)', bits: FLAG_GATEWAY_PRESENCE | FLAG_GATEWAY_PRESENCE_LIMITED, needed: true },
      { name: 'GuildMembers (SERVER MEMBERS)', bits: FLAG_GATEWAY_GUILD_MEMBERS | FLAG_GATEWAY_GUILD_MEMBERS_LIMITED, needed: true },
      { name: 'MessageContent (MESSAGE CONTENT)', bits: FLAG_GATEWAY_MESSAGE_CONTENT | FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED, needed: true },
    ];
    for (const ic of intentChecks) {
      const enabled = (flags & ic.bits) !== 0;
      checks.push({
        id: `intent.${ic.name}`,
        label: `Privileged Intent: ${ic.name}`,
        status: enabled ? 'pass' : 'fail',
        hint: enabled ? undefined : 'Im Developer Portal unter Bot -> Privileged Gateway Intents aktivieren.',
      });
    }

    // 4) Public-Bot / Code-Grant
    if (app.data.bot_public === false) {
      checks.push({
        id: 'app.public', label: 'Public Bot', status: 'warn',
        hint: 'Nur du kannst den Bot einladen. Fuer Multi-Guild-Dashboard muss "Public Bot" aktiv sein.',
      });
    } else {
      checks.push({ id: 'app.public', label: 'Public Bot', status: 'pass' });
    }
    if (app.data.bot_require_code_grant) {
      checks.push({
        id: 'app.codeGrant', label: 'OAuth2 Code Grant deaktiviert', status: 'fail',
        hint: 'Im Developer Portal "Requires OAuth2 Code Grant" ausschalten — sonst kann der Bot nicht eingeladen werden.',
      });
    } else {
      checks.push({ id: 'app.codeGrant', label: 'OAuth2 Code Grant deaktiviert', status: 'pass' });
    }
  } else {
    checks.push({
      id: 'app.fetch', label: 'Application-Daten lesbar', status: 'fail',
      hint: 'Bot-Token konnte Application nicht laden. Erneut Token pruefen.',
      detail: app.message,
    });
  }

  // 5) Redirect-URI-Plausibilitaet
  try {
    const dashUrl = new URL(config.dashboard.url);
    const redirectUrl = new URL(config.dashboard.oauth2RedirectUri);
    const hostsMatch = dashUrl.host === redirectUrl.host;
    const schemesMatch = dashUrl.protocol === redirectUrl.protocol;
    if (!redirectUrl.pathname.endsWith('/auth/callback')) {
      checks.push({
        id: 'oauth.path', label: 'OAUTH2_REDIRECT_URI Pfad', status: 'fail',
        hint: 'Pfad muss auf /auth/callback enden — sonst greift Discord 404 oder leitet falsch weiter.',
        detail: redirectUrl.pathname,
      });
    } else {
      checks.push({ id: 'oauth.path', label: 'OAUTH2_REDIRECT_URI Pfad', status: 'pass' });
    }
    if (!hostsMatch || !schemesMatch) {
      checks.push({
        id: 'oauth.match', label: 'DASHBOARD_URL und OAUTH2_REDIRECT_URI konsistent', status: 'warn',
        hint: 'Beide Variablen sollten denselben Host und Schema teilen, sonst zerschiesst der Cookie-Scope die Session.',
        detail: `${dashUrl.protocol}//${dashUrl.host} vs ${redirectUrl.protocol}//${redirectUrl.host}`,
      });
    } else {
      checks.push({ id: 'oauth.match', label: 'DASHBOARD_URL und OAUTH2_REDIRECT_URI konsistent', status: 'pass' });
    }
    const isLocalhost = redirectUrl.hostname === 'localhost' || redirectUrl.hostname === '127.0.0.1';
    if (redirectUrl.protocol !== 'https:' && !isLocalhost) {
      checks.push({
        id: 'oauth.https', label: 'OAUTH2_REDIRECT_URI ist https (oder localhost)', status: 'fail',
        hint: 'Discord lehnt nicht-https-Redirects ausserhalb von localhost ab.',
        detail: redirectUrl.protocol,
      });
    } else {
      checks.push({ id: 'oauth.https', label: 'OAUTH2_REDIRECT_URI ist https (oder localhost)', status: 'pass' });
    }
    if (config.dashboard.url.endsWith('/')) {
      checks.push({
        id: 'oauth.trailingSlash', label: 'DASHBOARD_URL ohne trailing /', status: 'warn',
        hint: 'Trailing-Slash erzeugt Doppel-Slashes wie ${DASHBOARD_URL}/dashboard => 404.',
      });
    }
  } catch (e) {
    checks.push({
      id: 'oauth.parse', label: 'OAuth-URLs parsbar', status: 'fail',
      hint: 'DASHBOARD_URL oder OAUTH2_REDIRECT_URI ist keine valide URL.',
      detail: (e as Error).message,
    });
  }

  // 6) Bot-Gateway verbunden
  const client = tryGetDashboardClient();
  if (!client) {
    checks.push({
      id: 'gateway.client', label: 'Bot-Client registriert', status: 'fail',
      hint: 'Dashboard-Server bekommt keinen Discord.js-Client. setDashboardClient muss vor startDashboard aufgerufen werden.',
    });
  } else if (client.ws.status === 0 /* READY */) {
    checks.push({
      id: 'gateway.ready', label: 'Gateway-Verbindung READY', status: 'pass',
      detail: `${client.guilds.cache.size} Guild(s) im Cache, Ping ${client.ws.ping}ms`,
    });
  } else {
    checks.push({
      id: 'gateway.ready', label: 'Gateway-Verbindung READY', status: 'warn',
      hint: 'Bot ist (noch) nicht READY. Status-Code siehe discord.js WebSocketShard#status.',
      detail: `ws.status=${client.ws.status}`,
    });
  }

  // 7) Crypto-Material
  if (!config.security.encryptionKey || config.security.encryptionKey.length < 32) {
    checks.push({
      id: 'crypto.encryptionKey', label: 'ENCRYPTION_KEY mind. 32 Bytes', status: 'fail',
      hint: 'In .env: openssl rand -hex 32 -> ENCRYPTION_KEY=...',
    });
  } else {
    checks.push({ id: 'crypto.encryptionKey', label: 'ENCRYPTION_KEY mind. 32 Bytes', status: 'pass' });
  }
  if (!config.dashboard.sessionSecret || config.dashboard.sessionSecret.length < 32) {
    checks.push({
      id: 'crypto.sessionSecret', label: 'SESSION_SECRET mind. 32 Bytes', status: 'fail',
      hint: 'In .env: openssl rand -hex 32 -> SESSION_SECRET=...',
    });
  } else {
    checks.push({ id: 'crypto.sessionSecret', label: 'SESSION_SECRET mind. 32 Bytes', status: 'pass' });
  }

  const ok = checks.every(c => c.status !== 'fail');
  if (!ok) {
    logger.warn(`Discord-Health: ${checks.filter(c => c.status === 'fail').length} Fail(s), ${checks.filter(c => c.status === 'warn').length} Warning(s).`);
  }
  res.status(ok ? 200 : 503).json({ ok, checks });
});
