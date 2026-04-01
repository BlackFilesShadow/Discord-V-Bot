import { Router, Request, Response } from 'express';
import axios from 'axios';
import crypto from 'crypto';
import prisma from '../../database/prisma';
import { config } from '../../config';
import { encrypt, decrypt, generateCsrfToken, generateNonce, generatePKCE, generate2FASecret, generateBackupCodes } from '../../utils/security';
import { verify2FAToken } from '../../utils/security';
import { logger, logAudit } from '../../utils/logger';

/**
 * OAuth2-Authentifizierung (Sektion 12):
 * - Nur Discord OAuth2 (keine Drittanbieter-Logins)
 * - Scopes: identify, guilds, email
 * - State-Parameter für CSRF-Schutz, Nonce für Replay-Schutz
 * - PKCE für Public Clients
 * - Access-Token nie persistent speichern, nur im RAM, kurze Lebensdauer
 * - Refresh-Token verschlüsselt, nur Server-seitig
 * - Tokens niemals im Frontend/Client anzeigen oder loggen
 */

export const authRouter = Router();

// In-Memory Token-Cache (Access-Tokens nie persistent!)
const tokenCache = new Map<string, { accessToken: string; expiresAt: Date }>();

const DISCORD_AUTH_URL = 'https://discord.com/api/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_API_URL = 'https://discord.com/api/v10';

/**
 * Login-Start: Weiterleitung zu Discord OAuth2.
 * Sektion 12: State-Parameter, Nonce, PKCE.
 */
authRouter.get('/login', (req: Request, res: Response) => {
  const state = generateCsrfToken();
  const nonce = generateNonce();
  const pkce = generatePKCE();

  // State und PKCE in Session speichern
  (req.session as any).oauthState = state;
  (req.session as any).oauthNonce = nonce;
  (req.session as any).pkceVerifier = pkce.codeVerifier;

  const params = new URLSearchParams({
    client_id: config.discord.clientId,
    redirect_uri: config.dashboard.oauth2RedirectUri,
    response_type: 'code',
    scope: 'identify guilds email',
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: 'S256',
  });

  logAudit('OAUTH2_LOGIN_INITIATED', 'AUTH', { ip: req.ip });
  res.redirect(`${DISCORD_AUTH_URL}?${params.toString()}`);
});

/**
 * OAuth2 Callback: Token-Austausch.
 * Sektion 12: Redirect-URIs strikt whitelisten.
 */
authRouter.get('/callback', async (req: Request, res: Response) => {
  const { code, state } = req.query;

  // State-Validierung (CSRF-Schutz)
  const savedState = (req.session as any).oauthState;
  if (!state || state !== savedState) {
    logAudit('OAUTH2_STATE_MISMATCH', 'SECURITY', { ip: req.ip });
    res.status(403).json({ error: 'Ungültiger State-Parameter (CSRF-Schutz)' });
    return;
  }

  if (!code) {
    res.status(400).json({ error: 'Kein Autorisierungscode erhalten' });
    return;
  }

  try {
    // Token-Austausch mit PKCE
    const tokenResponse = await axios.post(DISCORD_TOKEN_URL, new URLSearchParams({
      client_id: config.discord.clientId,
      client_secret: config.discord.clientSecret,
      grant_type: 'authorization_code',
      code: code as string,
      redirect_uri: config.dashboard.oauth2RedirectUri,
      code_verifier: (req.session as any).pkceVerifier || '',
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token, refresh_token, expires_in, scope, token_type } = tokenResponse.data;

    // User-Info von Discord holen
    const userResponse = await axios.get(`${DISCORD_API_URL}/users/@me`, {
      headers: { Authorization: `${token_type} ${access_token}` },
    });

    const discordUser = userResponse.data;

    // User in DB erstellen/aktualisieren
    const dbUser = await prisma.user.upsert({
      where: { discordId: discordUser.id },
      create: {
        discordId: discordUser.id,
        username: discordUser.username,
        discriminator: discordUser.discriminator || '',
        email: discordUser.email,
      },
      update: {
        username: discordUser.username,
        email: discordUser.email,
      },
    });

    // Refresh-Token verschlüsselt speichern (Sektion 12: Refresh-Token verschlüsselt, Server-seitig)
    const encryptedRefresh = refresh_token ? encrypt(refresh_token, config.security.encryptionKey) : null;

    // Sektion 12: Access-Token NICHT persistent speichern, NUR im RAM!
    // Nur Refresh-Token verschlüsselt in DB
    await prisma.oAuthToken.create({
      data: {
        userId: dbUser.id,
        refreshTokenEnc: encryptedRefresh,
        tokenType: token_type,
        scope,
        expiresAt: new Date(Date.now() + expires_in * 1000),
      },
    });

    // Access-Token in Memory-Cache (nie persistent!)
    const sessionToken = crypto.randomBytes(32).toString('hex');
    tokenCache.set(sessionToken, {
      accessToken: access_token,
      expiresAt: new Date(Date.now() + expires_in * 1000),
    });

    // Session erstellen (mit Device-Bindung)
    const dbSession = await prisma.session.create({
      data: {
        userId: dbUser.id,
        token: sessionToken,
        deviceInfo: req.get('user-agent') || null,
        ipAddress: req.ip || null,
        expiresAt: new Date(Date.now() + config.security.sessionTimeoutMinutes * 60 * 1000),
      },
    });

    // Session-Cookie setzen
    (req.session as any).sessionToken = sessionToken;
    (req.session as any).userId = dbUser.id;
    (req.session as any).discordId = discordUser.id;
    (req.session as any).role = dbUser.role;

    // Cleanup
    delete (req.session as any).oauthState;
    delete (req.session as any).oauthNonce;
    delete (req.session as any).pkceVerifier;

    logAudit('OAUTH2_LOGIN_SUCCESS', 'AUTH', {
      userId: dbUser.id, discordId: discordUser.id, ip: req.ip,
    });

    // Sektion 12: 2FA verpflichtend für Developer/Admins — kein Zugriff ohne 2FA!
    if (['ADMIN', 'SUPER_ADMIN', 'DEVELOPER'].includes(dbUser.role)) {
      const twoFA = await prisma.twoFactorAuth.findUnique({ where: { userId: dbUser.id } });
      // 2FA immer erzwingen: Wenn nicht eingerichtet, zur Setup-Seite leiten
      (req.session as any).requires2FA = true;
      if (!twoFA?.isEnabled) {
        res.redirect(`${config.dashboard.url}/auth/2fa/setup`);
        return;
      }
      res.redirect(`${config.dashboard.url}/auth/2fa`);
      return;
    }

    res.redirect(`${config.dashboard.url}/dashboard`);
  } catch (error) {
    logger.error('OAuth2 Callback Fehler:', error);
    logAudit('OAUTH2_LOGIN_FAILURE', 'SECURITY', { ip: req.ip, error: String(error) });
    res.status(500).json({ error: 'Anmeldefehler' });
  }
});

/**
 * 2FA-Setup: TOTP-Secret generieren und QR-Daten zurückgeben.
 * Sektion 12: 2FA-Einrichtung für Admin/Developer.
 */
authRouter.post('/2fa/setup', async (req: Request, res: Response) => {
  const userId = (req.session as any).userId;

  if (!userId) {
    res.status(401).json({ error: 'Nicht angemeldet' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).json({ error: 'User nicht gefunden' });
    return;
  }

  // Prüfe ob 2FA bereits eingerichtet
  const existing = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (existing?.isEnabled) {
    res.status(400).json({ error: '2FA ist bereits aktiviert' });
    return;
  }

  // TOTP-Secret generieren
  const { secret, otpAuthUrl, base32 } = generate2FASecret(user.username, 'Discord-V-Bot');
  const backupCodes = generateBackupCodes(10);

  // Secret verschlüsselt speichern (noch nicht aktiviert)
  const encryptedSecret = encrypt(base32, config.security.encryptionKey);
  const encryptedBackupCodes = encrypt(JSON.stringify(backupCodes), config.security.encryptionKey);

  await prisma.twoFactorAuth.upsert({
    where: { userId },
    create: {
      userId,
      secretEnc: encryptedSecret,
      backupCodes: encryptedBackupCodes,
      isEnabled: false,
    },
    update: {
      secretEnc: encryptedSecret,
      backupCodes: encryptedBackupCodes,
      isEnabled: false,
    },
  });

  logAudit('2FA_SETUP_INITIATED', 'AUTH', { userId, ip: req.ip });

  res.json({
    otpAuthUrl,
    base32,
    backupCodes,
    message: 'Scanne den QR-Code mit deiner Authenticator-App und bestätige mit /2fa/setup/confirm.',
  });
});

/**
 * 2FA-Setup bestätigen: Ersten TOTP-Code verifizieren und 2FA aktivieren.
 */
authRouter.post('/2fa/setup/confirm', async (req: Request, res: Response) => {
  const userId = (req.session as any).userId;
  const { token } = req.body;

  if (!userId) {
    res.status(401).json({ error: 'Nicht angemeldet' });
    return;
  }

  if (!token || typeof token !== 'string' || token.length !== 6) {
    res.status(400).json({ error: 'Ungültiger TOTP-Code (6 Ziffern erwartet)' });
    return;
  }

  const twoFA = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!twoFA?.secretEnc) {
    res.status(400).json({ error: '2FA-Setup nicht gestartet. Rufe zuerst /2fa/setup auf.' });
    return;
  }

  if (twoFA.isEnabled) {
    res.status(400).json({ error: '2FA ist bereits aktiviert' });
    return;
  }

  const secret = decrypt(twoFA.secretEnc, config.security.encryptionKey);
  const isValid = verify2FAToken(secret, token);

  if (!isValid) {
    logAudit('2FA_SETUP_CONFIRM_FAILED', 'SECURITY', { userId, ip: req.ip });
    res.status(401).json({ error: 'Ungültiger TOTP-Code. Versuche es erneut.' });
    return;
  }

  // 2FA aktivieren
  await prisma.twoFactorAuth.update({
    where: { userId },
    data: { isEnabled: true },
  });

  (req.session as any).requires2FA = false;

  logAudit('2FA_SETUP_COMPLETE', 'AUTH', { userId, ip: req.ip });
  res.json({ success: true, message: '2FA erfolgreich aktiviert!' });
});

/**
 * 2FA-Verifizierung (Sektion 12: 2FA verpflichtend für Developer/Admins).
 */
authRouter.post('/2fa/verify', async (req: Request, res: Response) => {
  const { token } = req.body;
  const userId = (req.session as any).userId;

  if (!userId) {
    res.status(401).json({ error: 'Nicht angemeldet' });
    return;
  }

  const twoFA = await prisma.twoFactorAuth.findUnique({ where: { userId } });
  if (!twoFA || !twoFA.isEnabled || !twoFA.secretEnc) {
    res.status(400).json({ error: '2FA nicht aktiviert' });
    return;
  }

  const secret = decrypt(twoFA.secretEnc, config.security.encryptionKey);
  const isValid = verify2FAToken(secret, token);

  if (!isValid) {
    logAudit('2FA_VERIFICATION_FAILED', 'SECURITY', { userId, ip: req.ip });
    res.status(401).json({ error: 'Ungültiger 2FA-Code' });
    return;
  }

  (req.session as any).requires2FA = false;
  logAudit('2FA_VERIFICATION_SUCCESS', 'AUTH', { userId, ip: req.ip });
  res.json({ success: true });
});

/**
 * Logout: Session beenden, Tokens löschen.
 */
authRouter.post('/logout', async (req: Request, res: Response) => {
  const sessionToken = (req.session as any).sessionToken;
  const userId = (req.session as any).userId;

  if (sessionToken) {
    tokenCache.delete(sessionToken);
    await prisma.session.updateMany({
      where: { token: sessionToken },
      data: { isActive: false },
    });
  }

  logAudit('LOGOUT', 'AUTH', { userId, ip: req.ip });

  req.session.destroy((err) => {
    if (err) logger.error('Session-Destroy Fehler:', err);
    res.json({ success: true });
  });
});

/**
 * Session-Status prüfen.
 */
authRouter.get('/status', async (req: Request, res: Response) => {
  const sessionToken = (req.session as any).sessionToken;
  if (!sessionToken) {
    res.json({ authenticated: false });
    return;
  }

  const cachedToken = tokenCache.get(sessionToken);
  if (!cachedToken || cachedToken.expiresAt <= new Date()) {
    // Token abgelaufen, Refresh versuchen
    const dbSession = await prisma.session.findUnique({
      where: { token: sessionToken },
      include: { user: true },
    });

    if (!dbSession || !dbSession.isActive || dbSession.expiresAt <= new Date()) {
      tokenCache.delete(sessionToken);
      res.json({ authenticated: false });
      return;
    }

    // Token-Refresh (Sektion 12: Rotation erzwingen)
    const latestToken = await prisma.oAuthToken.findFirst({
      where: { userId: dbSession.userId },
      orderBy: { createdAt: 'desc' },
    });

    if (latestToken?.refreshTokenEnc) {
      try {
        const refreshToken = decrypt(latestToken.refreshTokenEnc, config.security.encryptionKey);
        const tokenResponse = await axios.post(DISCORD_TOKEN_URL, new URLSearchParams({
          client_id: config.discord.clientId,
          client_secret: config.discord.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const { access_token, refresh_token: newRefresh, expires_in } = tokenResponse.data;

        // Neues Token cachen
        tokenCache.set(sessionToken, {
          accessToken: access_token,
          expiresAt: new Date(Date.now() + expires_in * 1000),
        });

        // Altes Token entfernen, neues speichern (Rotation, ohne Access-Token in DB)
        await prisma.oAuthToken.delete({ where: { id: latestToken.id } });
        await prisma.oAuthToken.create({
          data: {
            userId: dbSession.userId,
            refreshTokenEnc: newRefresh ? encrypt(newRefresh, config.security.encryptionKey) : null,
            tokenType: 'Bearer',
            scope: latestToken.scope,
            expiresAt: new Date(Date.now() + expires_in * 1000),
            lastRefresh: new Date(),
          },
        });

        logAudit('TOKEN_REFRESHED', 'AUTH', { userId: dbSession.userId });
      } catch {
        tokenCache.delete(sessionToken);
        res.json({ authenticated: false });
        return;
      }
    }
  }

  const requires2FA = (req.session as any).requires2FA || false;

  res.json({
    authenticated: true,
    requires2FA,
    userId: (req.session as any).userId,
    role: (req.session as any).role,
  });
});

/**
 * Bereinigt abgelaufene Tokens aus dem Cache.
 */
setInterval(() => {
  const now = new Date();
  for (const [key, value] of tokenCache) {
    if (value.expiresAt <= now) {
      tokenCache.delete(key);
    }
  }
}, 5 * 60 * 1000);
