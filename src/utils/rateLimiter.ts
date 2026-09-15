import prisma from '../database/prisma';
import { logSecurity } from './logger';

/**
 * Rate-Limiter für Commands, Downloads, Login-Versuche.
 * Sektion 2: Download-Tracking, Rate-Limit, Abuse-Detection.
 * Sektion 4: Rate-Limit, Abuse-Detection, Anti-Spam, Anti-Raid.
 * Sektion 12: Rate-Limit für Login-Versuche, IP- und Verhaltensanalyse.
 */

interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_LIMITS: Record<string, RateLimitConfig> = {
  command: { windowMs: 60000, maxRequests: 30 },
  upload: { windowMs: 300000, maxRequests: 10 },
  download: { windowMs: 60000, maxRequests: 20 },
  login: { windowMs: 900000, maxRequests: 5 },
  message: { windowMs: 10000, maxRequests: 5 },
  api: { windowMs: 60000, maxRequests: 60 },
  ai: { windowMs: 60_000, maxRequests: 20 },
};

export async function checkRateLimit(
  identifier: string,
  action: string,
  customConfig?: RateLimitConfig
): Promise<{ allowed: boolean; remaining: number; resetAt: Date }> {
  const config = customConfig || DEFAULT_LIMITS[action] || DEFAULT_LIMITS.command;
  const now = new Date();
  const windowStart = new Date(now.getTime() - config.windowMs);

  try {
    // Bis zu zwei Versuche: der zweite faengt nur den seltenen Grenzfall ab,
    // dass ein neues Fenster genau zwischen unserem fehlgeschlagenen
    // Increment und dem Nachlesen von einer anderen Anfrage eroeffnet wurde.
    for (let attempt = 0; attempt < 2; attempt++) {
      // Atomarer, bedingter Increment statt read-then-write (frueher:
      // findUnique + separates update). Zwei nahezu gleichzeitige Anfragen
      // konnten denselben count-Stand lesen und das Limit gemeinsam um
      // einen Request ueberschreiten (TOCTOU-Race). Die Bedingung im WHERE
      // (Fenster aktiv UND count < Limit) macht den Schreibvorgang selbst
      // zur Entscheidung, nicht eine vorherige Lesung.
      const incremented = await prisma.rateLimitEntry.updateMany({
        where: {
          identifier,
          action,
          windowStart: { gt: windowStart },
          count: { lt: config.maxRequests },
        },
        data: { count: { increment: 1 } },
      });

      if (incremented.count === 1) {
        const row = await prisma.rateLimitEntry.findUnique({
          where: { identifier_action: { identifier, action } },
        });
        if (row) {
          return {
            allowed: true,
            remaining: config.maxRequests - row.count,
            resetAt: new Date(row.windowStart.getTime() + config.windowMs),
          };
        }
      }

      const existing = await prisma.rateLimitEntry.findUnique({
        where: { identifier_action: { identifier, action } },
      });

      if (existing && existing.windowStart > windowStart) {
        if (existing.count < config.maxRequests) {
          // Der bedingte Increment ist an einer parallelen Aenderung
          // vorbeigelaufen (Fenster wurde gerade erst eroeffnet) - noch ein
          // Versuch statt faelschlich abzulehnen.
          continue;
        }
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
    }

    // Nach mehreren Versuchen immer noch keine eindeutige Entscheidung
    // moeglich (starke Gleichzeitigkeit) - fail-closed statt unbegrenzt
    // durchzulassen.
    logSecurity('RATE_LIMIT_CONTENTION', 'MEDIUM', { identifier, action });
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(now.getTime() + config.windowMs),
    };
  } catch (_error) {
    // Externe AI-Provider verursachen reale Kontingent-/Kostenlast. Wenn der
    // persistente Quota-Store ausfällt, darf dieser eine Pfad deshalb nicht
    // fail-open unbegrenzt Provider-Aufrufe erzeugen. Andere lokale Aktionen
    // behalten das historische Availability-Verhalten.
    if (action === 'ai') {
      logSecurity('AI_RATE_LIMIT_STORE_UNAVAILABLE', 'HIGH', { identifier, action });
      return {
        allowed: false,
        remaining: 0,
        resetAt: new Date(now.getTime() + config.windowMs),
      };
    }
    return {
      allowed: true,
      remaining: config.maxRequests,
      resetAt: new Date(now.getTime() + config.windowMs),
    };
  }
}

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

export function detectSpam(
  messages: { content: string; timestamp: number }[],
  windowMs: number = 5000,
  threshold: number = 5
): boolean {
  if (messages.length < threshold) return false;

  const now = Date.now();
  const recentMessages = messages.filter(m => now - m.timestamp < windowMs);

  if (recentMessages.length >= threshold) {
    const contentSet = new Set(recentMessages.map(m => m.content.toLowerCase()));
    if (contentSet.size <= 2) {
      return true;
    }
  }

  return false;
}

let cleanupTimer: NodeJS.Timeout | null = null;

/** Periodische Bereinigung abgelaufener Rate-Limit-Einträge. */
export function startRateLimitCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    try {
      await prisma.rateLimitEntry.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
    } catch { /* ignore */ }
  }, 5 * 60 * 1000);
  cleanupTimer.unref?.();
}

export function stopRateLimitCleanup(): void {
  if (!cleanupTimer) return;
  clearInterval(cleanupTimer);
  cleanupTimer = null;
}
