import crypto from 'crypto';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';
import { sha256Hash } from '../../utils/security';

/**
 * API-Key Management (Sektion 7):
 * - API-Key Erstellung, Rotation, Widerruf
 * - Berechtigungsbasierter Zugriff
 * - Rate-Limiting pro Key
 */

const API_KEY_PREFIX = 'dvb_';
const KEY_LENGTH = 48;

/**
 * Neuen API-Key erstellen.
 * Der Key wird nur einmalig im Klartext zurückgegeben.
 */
export async function createApiKey(
  userId: string,
  name: string,
  permissions: string[] = ['read'],
  rateLimit: number = 100,
  expiresInDays?: number,
): Promise<{ key: string; id: string }> {
  const rawKey = API_KEY_PREFIX + crypto.randomBytes(KEY_LENGTH).toString('base64url');
  const keyHash = sha256Hash(rawKey);
  const keyPrefix = rawKey.substring(0, 12);

  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000)
    : undefined;

  const apiKey = await prisma.apiKey.create({
    data: {
      userId,
      name,
      keyHash,
      keyPrefix,
      permissions: permissions,
      rateLimit,
      isActive: true,
      expiresAt,
    },
  });

  logAudit('API_KEY_CREATED', 'API_KEY', {
    userId,
    keyId: apiKey.id,
    name,
    permissions,
    expiresAt,
  });

  return { key: rawKey, id: apiKey.id };
}

/**
 * API-Key validieren und Benutzer/Berechtigungen zurückgeben.
 */
export async function validateApiKey(
  rawKey: string,
): Promise<{
  valid: boolean;
  userId?: string;
  permissions?: string[];
  keyId?: string;
  error?: string;
}> {
  if (!rawKey.startsWith(API_KEY_PREFIX)) {
    return { valid: false, error: 'Ungültiges Key-Format.' };
  }

  const keyHash = sha256Hash(rawKey);

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
  });

  if (!apiKey) {
    return { valid: false, error: 'API-Key nicht gefunden.' };
  }

  if (!apiKey.isActive) {
    return { valid: false, error: 'API-Key deaktiviert.' };
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return { valid: false, error: 'API-Key abgelaufen.' };
  }

  // LastUsedAt aktualisieren
  await prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  });

  return {
    valid: true,
    userId: apiKey.userId,
    permissions: apiKey.permissions as string[],
    keyId: apiKey.id,
  };
}

/**
 * API-Key widerrufen.
 */
export async function revokeApiKey(keyId: string, revokedBy: string): Promise<boolean> {
  const key = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!key) return false;

  await prisma.apiKey.update({
    where: { id: keyId },
    data: { isActive: false },
  });

  logAudit('API_KEY_REVOKED', 'API_KEY', {
    keyId,
    revokedBy,
    userId: key.userId,
  });

  return true;
}

/**
 * API-Key rotieren: alten widerrufen, neuen erstellen.
 */
export async function rotateApiKey(
  keyId: string,
  rotatedBy: string,
): Promise<{ key: string; id: string } | null> {
  const oldKey = await prisma.apiKey.findUnique({ where: { id: keyId } });
  if (!oldKey) return null;

  // Alten Key deaktivieren
  await prisma.apiKey.update({
    where: { id: keyId },
    data: { isActive: false },
  });

  // Verbleibende Gültigkeit berechnen
  let expiresInDays: number | undefined;
  if (oldKey.expiresAt) {
    const remaining = oldKey.expiresAt.getTime() - Date.now();
    if (remaining > 0) {
      expiresInDays = Math.ceil(remaining / (24 * 60 * 60 * 1000));
    }
  }

  // Neuen Key mit gleichen Berechtigungen erstellen
  const newKey = await createApiKey(
    oldKey.userId,
    oldKey.name,
    oldKey.permissions as string[],
    oldKey.rateLimit,
    expiresInDays,
  );

  logAudit('API_KEY_ROTATED', 'API_KEY', {
    oldKeyId: keyId,
    newKeyId: newKey.id,
    rotatedBy,
  });

  return newKey;
}

/**
 * Alle API-Keys eines Benutzers auflisten (ohne Hashes).
 */
export async function listApiKeys(userId: string) {
  return prisma.apiKey.findMany({
    where: { userId },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      permissions: true,
      rateLimit: true,
      isActive: true,
      lastUsedAt: true,
      expiresAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Express Middleware: API-Key Authentifizierung.
 */
export function apiKeyAuthMiddleware() {
  return async (req: any, res: any, next: any) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return next(); // Kein API-Key, weiter mit Session-Auth
    }

    const rawKey = authHeader.substring(7);
    const result = await validateApiKey(rawKey);

    if (!result.valid) {
      return res.status(401).json({ error: result.error });
    }

    // User in Request setzen
    req.apiKeyAuth = {
      userId: result.userId,
      permissions: result.permissions,
      keyId: result.keyId,
    };

    next();
  };
}
