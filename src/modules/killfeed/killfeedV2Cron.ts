/**
 * Killfeed-V2-Cron (Phase 6). Speist den Killfeed aus normalisierten AdmEvents
 * (statt aus dem alten Parser). Idempotent ueber KillfeedDelivery. Wird nur
 * gestartet, wenn ADM_EVENT_PIPELINE_V2 aktiv ist; sonst laeuft der alte
 * admWatcher weiter (kein Doppel-Posting).
 */

import type { GuildTextBasedChannel } from 'discord.js';
import prisma from '../../database/prisma';
import { logger } from '../../utils/logger';
import { tryGetDashboardClient } from '../../dashboard/clientRegistry';
import { buildKillfeedEmbedV2 } from './embedBuilder';
import { deliverPendingKills, type DeliverClient, type KillfeedConfigRow, type KillfeedView } from './killfeedV2';

const POLL_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export async function deliverKillfeedV2Once(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const client = tryGetDashboardClient();
    if (!client) return;

    // eslint-disable-next-line local/no-unscoped-prisma-query -- Cron iteriert alle Guilds; Delivery ist pro Config (guildId) gebunden.
    const configs = await prisma.killfeedConfig.findMany({
      where: { isActive: true },
      select: {
        id: true, guildId: true, nitradoConnId: true, channelId: true, embedColor: true,
        showShooterCoords: true, showVictimCoords: true, showWeapon: true, showDistance: true,
      },
    });

    for (const cfg of configs) {
      try {
        const poster = async (view: KillfeedView): Promise<string | null> => {
          const ch = await client.channels.fetch(cfg.channelId).catch(() => null);
          if (!ch || !ch.isTextBased() || ch.isDMBased()) return null;
          const msg = await (ch as GuildTextBasedChannel).send({
            embeds: [buildKillfeedEmbedV2(view, cfg.embedColor)],
            allowedMentions: { parse: [] },
          });
          return msg.id;
        };
        await deliverPendingKills(prisma as unknown as DeliverClient, cfg as KillfeedConfigRow, poster);
      } catch (e) {
        logger.warn(`Killfeed V2: Delivery fehlgeschlagen fuer Config ${cfg.id}: ${(e as Error).message}`);
      }
    }
  } finally {
    running = false;
  }
}

export function startKillfeedV2Cron(): void {
  if (timer) return;
  timer = setInterval(() => { void deliverKillfeedV2Once(); }, POLL_INTERVAL_MS);
  timer.unref?.();
  void deliverKillfeedV2Once();
}

export function stopKillfeedV2Cron(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
