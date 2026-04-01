import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

/**
 * Feature-Toggles System (Sektion 7):
 * - Funktionen dynamisch ein-/ausschalten über BotConfig
 * - Default-Werte wenn nicht konfiguriert
 * - Caching für Performance
 */

interface FeatureToggle {
  key: string;
  enabled: boolean;
  description: string;
}

// In-Memory Cache für Feature-Toggles (aktualisiert sich alle 60 Sekunden)
const toggleCache: Map<string, boolean> = new Map();
let lastCacheRefresh = 0;
const CACHE_TTL = 60_000; // 60 Sekunden

// Standard Feature-Definitionen
const DEFAULT_FEATURES: Record<string, { enabled: boolean; description: string }> = {
  'upload.enabled': { enabled: true, description: 'Upload-System aktiv' },
  'upload.chunked': { enabled: true, description: 'Chunked-Upload erlaubt' },
  'download.enabled': { enabled: true, description: 'Download-System aktiv' },
  'download.tar': { enabled: true, description: 'TAR-Download Format verfügbar' },
  'ai.enabled': { enabled: true, description: 'AI-Integration aktiv' },
  'ai.autoResponder': { enabled: true, description: 'AI Auto-Responder aktiv' },
  'ai.toxicityDetection': { enabled: true, description: 'AI Toxicity-Detection aktiv' },
  'moderation.automod': { enabled: true, description: 'Auto-Moderation aktiv' },
  'moderation.antiSpam': { enabled: true, description: 'Anti-Spam aktiv' },
  'giveaway.enabled': { enabled: true, description: 'Giveaway-System aktiv' },
  'xp.enabled': { enabled: true, description: 'XP/Level-System aktiv' },
  'xp.voiceXp': { enabled: true, description: 'Voice-Channel XP aktiv' },
  'xp.eventXp': { enabled: true, description: 'Event-XP aktiv' },
  'polls.enabled': { enabled: true, description: 'Umfrage-System aktiv' },
  'autorole.enabled': { enabled: true, description: 'Automatische Rollenvergabe aktiv' },
  'feeds.enabled': { enabled: true, description: 'Feed-System aktiv' },
  'dashboard.enabled': { enabled: true, description: 'Web-Dashboard aktiv' },
  'dashboard.registration': { enabled: true, description: 'Neue Registrierungen erlaubt' },
  'analytics.enabled': { enabled: true, description: 'Analytics & Logging aktiv' },
  'inviteTracking.enabled': { enabled: true, description: 'Invite-Tracking aktiv' },
};

/**
 * Feature-Toggle prüfen.
 */
export async function isFeatureEnabled(featureKey: string): Promise<boolean> {
  // Cache aktualisieren falls nötig
  if (Date.now() - lastCacheRefresh > CACHE_TTL) {
    await refreshCache();
  }

  // Aus Cache lesen
  if (toggleCache.has(featureKey)) {
    return toggleCache.get(featureKey)!;
  }

  // Default verwenden
  const defaultFeature = DEFAULT_FEATURES[featureKey];
  return defaultFeature?.enabled ?? true;
}

/**
 * Feature-Toggle setzen.
 */
export async function setFeatureToggle(
  featureKey: string,
  enabled: boolean,
  updatedBy: string,
): Promise<void> {
  const configKey = `feature.${featureKey}`;

  await prisma.botConfig.upsert({
    where: { key: configKey },
    create: {
      key: configKey,
      value: { enabled },
      category: 'feature-toggles',
      description: DEFAULT_FEATURES[featureKey]?.description || featureKey,
      updatedBy,
    },
    update: {
      value: { enabled },
      updatedBy,
    },
  });

  // Cache sofort aktualisieren
  toggleCache.set(featureKey, enabled);

  logAudit('FEATURE_TOGGLE_CHANGED', 'CONFIG', {
    featureKey,
    enabled,
    updatedBy,
  });

  logger.info(`Feature-Toggle: ${featureKey} = ${enabled} (von ${updatedBy})`);
}

/**
 * Alle Feature-Toggles abrufen.
 */
export async function getAllFeatureToggles(): Promise<FeatureToggle[]> {
  await refreshCache();

  const toggles: FeatureToggle[] = [];

  for (const [key, def] of Object.entries(DEFAULT_FEATURES)) {
    toggles.push({
      key,
      enabled: toggleCache.get(key) ?? def.enabled,
      description: def.description,
    });
  }

  return toggles;
}

/**
 * Cache aus Datenbank aktualisieren.
 */
async function refreshCache(): Promise<void> {
  try {
    const configs = await prisma.botConfig.findMany({
      where: { category: 'feature-toggles' },
    });

    for (const cfg of configs) {
      const featureKey = cfg.key.replace('feature.', '');
      const value = cfg.value as { enabled?: boolean };
      if (typeof value.enabled === 'boolean') {
        toggleCache.set(featureKey, value.enabled);
      }
    }

    lastCacheRefresh = Date.now();
  } catch (error) {
    logger.error('Feature-Toggle Cache-Refresh Fehler:', error);
  }
}
