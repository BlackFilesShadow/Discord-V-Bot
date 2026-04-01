import prisma from '../database/prisma';
import { logSecurity } from './logger';

/**
 * Rate-Limiter für Commands, Downloads, Login-Versuche.
 * Sektion 2: Download-Tracking, Rate-Limit, Abuse-Detection.
 * Sektion 4: Rate-Limit, Abuse-Detection, Anti-Spam, Anti-Raid.
 * Sektion 12: Rate-Limit für Login-Versuche, IP- und Verhaltensanalyse.
 */

interface RateLimitConfig {
  windowMs: number;    // Zeitfenster in ms
  maxRequests: number; // Max. Anfragen im Zeitfenster
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  command: { windowMs: 60000, maxRequests: 30 },
  upload: { windowMs: 300000, maxRequests: 10 },
  download: { windowMs: 60000, maxRequests: 20 },
  login: { windowMs: 900000, maxRequests: 5 },      // 15 min, 5 Versuche
  message: { windowMs: 10000, maxRequests: 5 },
  reaction: { windowMs: 5000, maxRequests: 10 },
  api: { windowMs: 60000, maxRequests: 60 },
};

/**
 * Prüft ob ein Rate-Limit überschritten ist.
 * @returns true wenn erlaubt, false wenn Rate-Limit erreicht.
 */
export async function checkRateLimit(
  identifier: string,
  action: string,
  customConfig?: RateLimitConfig
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const config = customConfig || DEFAULT_LIMITS[action] || DEFAULT_LIMITS.command;
  const now = new Date();
  const windowStart = new Date(now.getTime() - config.windowMs);

  try {
    // Aufräumen abgelaufener Einträge
    await prisma.rateLimitEntry.deleteMany({
      where: { expiresAt: { lt: now } },
    });

    // Bestehenden Eintrag suchen
    const existing = await prisma.rateLimitEntry.findUnique({
      where: { identifier_action: { identifier, action } },
    });

    if (existing && existing.windowStart > windowStart) {
      // Innerhalb des Zeitfensters
      if (existing.count >= config.maxRequests) {
        // Rate-Limit erreicht
        logSecurity('RATE_LIMIT_EXCEEDED', 'MEDIUM', {
          identifier,
          action,
          count: existing.count,
          limit: config.maxRequests,
        });

        return {
          allowed: false,
          remaining: 0,
          resetAt: new Date(existing.windowStart.getTime() + config.windowMs),
        };
      }

      // Zähler erhöhen
      await prisma.rateLimitEntry.update({
        where: { identifier_action: { identifier, action } },
        data: { count: existing.count + 1 },
      });

      return {
        allowed: true,
        remaining: config.maxRequests - existing.count - 1,
        resetAt: new Date(existing.windowStart.getTime() + config.windowMs),
      };
    }

    // Neues Zeitfenster starten
    await prisma.rateLimitEntry.upsert({
      where: { identifier_action: { identifier, action } },
      create: {
        identifier,
        action,
        count: 1,
        windowStart: now,
        expiresAt: new Date(now.getTime() + config.windowMs),
      },
      update: {
        count: 1,
        windowStart: now,
        expiresAt: new Date(now.getTime() + config.windowMs),
      },
    });

    return {
      allowed: true,
      remaining: config.maxRequests - 1,
      resetAt: new Date(now.getTime() + config.windowMs),
    };
  } catch (error) {
    // Bei DB-Fehler: Erlauben (fail-open nur für Rate-Limiting)
    return {
      allowed: true,
      remaining: config.maxRequests,
      resetAt: new Date(now.getTime() + config.windowMs),
    };
  }
}

/**
 * Anti-Raid Detection.
 * Erkennt massenhaften Beitritt in kurzer Zeit.
 */
export async function detectRaid(
  guildId: string,
  joinCount: number,
  windowSeconds: number = 10,
  threshold: number = 10
): Promise<boolean> {
  if (joinCount >= threshold) {
    logSecurity('RAID_DETECTED', 'CRITICAL', {
      guildId,
      joinCount,
      windowSeconds,
      threshold,
    });
    return true;
  }
  return false;
}

/**
 * Anti-Spam Detection.
 * Erkennt Spam-Verhalten (wiederholte gleiche Nachrichten).
 */
export function detectSpam(
  messages: { content: string; timestamp: number }[],
  windowMs: number = 5000,
  threshold: number = 5
): boolean {
  if (messages.length < threshold) return false;

  const now = Date.now();
  const recentMessages = messages.filter(m => now - m.timestamp < windowMs);

  if (recentMessages.length >= threshold) {
    // Prüfe auf identische Nachrichten
    const contentSet = new Set(recentMessages.map(m => m.content.toLowerCase()));
    if (contentSet.size <= 2) {
      return true; // Spam erkannt
    }
  }

  return false;
}
