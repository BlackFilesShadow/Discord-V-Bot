/* eslint-disable local/no-unscoped-prisma-query -- Feed delivery claims are intentionally global idempotency records, namespaced by feedId+itemId rather than guild rows. */
import crypto from 'crypto';
import prisma from '../../database/prisma';
import { logger, logAudit } from '../../utils/logger';

const FEED_DELIVERY_PREFIX = 'feed-delivery:';
const FEED_DELIVERY_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const FEED_DELIVERY_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
let lastCleanupAt = 0;

export type FeedDeliveryResult = 'DELIVERED' | 'ALREADY_CLAIMED';

export function feedDeliveryClaimHash(feedId: string, itemId: string): string {
  return `${FEED_DELIVERY_PREFIX}${crypto
    .createHash('sha256')
    .update(`${feedId}\n${itemId}`)
    .digest('hex')}`;
}

async function createClaim(hash: string, now: Date): Promise<boolean> {
  try {
    await prisma.idempotencyKey.create({
      data: {
        hash,
        status: 'PROCESSING',
        expiresAt: new Date(now.getTime() + FEED_DELIVERY_TTL_MS),
      },
    });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code !== 'P2002') throw error;

    // Ein abgelaufener Claim darf gezielt ersetzt werden. Der Delete ist an
    // denselben Hash + expiresAt gebunden; parallele Worker koennen dadurch
    // nicht gleichzeitig denselben Item-Claim uebernehmen.
    const removed = await prisma.idempotencyKey.deleteMany({
      where: { hash, expiresAt: { lt: now } },
    });
    if (removed.count !== 1) return false;

    try {
      await prisma.idempotencyKey.create({
        data: {
          hash,
          status: 'PROCESSING',
          expiresAt: new Date(now.getTime() + FEED_DELIVERY_TTL_MS),
        },
      });
      return true;
    } catch (retryError) {
      if ((retryError as { code?: string }).code === 'P2002') return false;
      throw retryError;
    }
  }
}

async function releaseClaim(hash: string): Promise<void> {
  try {
    await prisma.idempotencyKey.delete({ where: { hash } });
  } catch (error) {
    // Fail-closed: Wenn der Delete selbst scheitert, bleibt der Claim bestehen.
    // Das kann einen Retry unterdruecken, verhindert aber einen moeglichen
    // Doppelpost bei einem mehrdeutigen Discord-Netzwerkfehler.
    logger.warn(`Feed-Delivery-Claim ${hash}: Freigabe nach Sendefehler fehlgeschlagen`, { error: String(error) });
  }
}

export async function deliverFeedItemOnce(
  feedId: string,
  itemId: string,
  send: () => Promise<void>,
  now = new Date(),
): Promise<FeedDeliveryResult> {
  if (!feedId || !itemId) throw new Error('Feed-Delivery-Claim benoetigt feedId und itemId.');
  const hash = feedDeliveryClaimHash(feedId, itemId);
  if (!(await createClaim(hash, now))) return 'ALREADY_CLAIMED';

  try {
    await send();
  } catch (error) {
    await releaseClaim(hash);
    throw error;
  }

  try {
    await prisma.idempotencyKey.update({
      where: { hash },
      data: {
        status: 'DONE',
        responseStatus: 200,
        responseBody: { kind: 'feed-delivery', feedId, itemId },
      },
    });
  } catch (error) {
    // Discord hat bereits erfolgreich zugestellt. Den PROCESSING-Claim niemals
    // loeschen: der naechste Poll muss dieses Item fail-closed ueberspringen.
    logger.error(`Feed ${feedId}: Discord-Zustellung fuer Item ${itemId} erfolgreich, Delivery-Finalisierung fehlgeschlagen`, { error: String(error) });
    logAudit('FEED_DELIVERY_FINALIZE_FAILED', 'SECURITY', { feedId, itemId });
  }

  return 'DELIVERED';
}

export async function cleanupExpiredFeedDeliveryClaims(now = new Date(), force = false): Promise<number> {
  if (!force && now.getTime() - lastCleanupAt < FEED_DELIVERY_CLEANUP_INTERVAL_MS) return 0;
  lastCleanupAt = now.getTime();
  try {
    const removed = await prisma.idempotencyKey.deleteMany({
      where: {
        hash: { startsWith: FEED_DELIVERY_PREFIX },
        expiresAt: { lt: now },
      },
    });
    if (removed.count > 0) logger.info(`Feed-Delivery-Claims bereinigt: ${removed.count}`);
    return removed.count;
  } catch (error) {
    lastCleanupAt = 0;
    logger.warn('Feed-Delivery-Claim-Cleanup fehlgeschlagen', { error: String(error) });
    return 0;
  }
}
