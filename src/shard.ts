import { ShardingManager } from 'discord.js';
import { config } from './config';
import { logger } from './utils/logger';
import path from 'path';

/**
 * Sharding-Manager (Sektion 5):
 * - Automatisches Sharding für Skalierung
 * - Startet pro Shard eine eigene Bot-Instanz (index.ts)
 * - Shard-Anzahl: 'auto' = Discord bestimmt automatisch
 *
 * Nutzung: `node dist/shard.js` statt `node dist/index.js`
 * Für kleine Bots (<2500 Guilds) ist Sharding optional — `index.ts` direkt starten.
 */

const manager = new ShardingManager(path.join(__dirname, 'index.js'), {
  token: config.discord.token,
  totalShards: 'auto',
  respawn: true,
});

manager.on('shardCreate', (shard) => {
  logger.info(`Shard ${shard.id} gestartet.`);

  shard.on('ready', () => {
    logger.info(`Shard ${shard.id} bereit.`);
  });

  shard.on('disconnect', () => {
    logger.warn(`Shard ${shard.id} getrennt.`);
  });

  shard.on('reconnecting', () => {
    logger.info(`Shard ${shard.id} verbindet sich erneut...`);
  });

  shard.on('death', () => {
    logger.error(`Shard ${shard.id} beendet.`);
  });

  shard.on('error', (error) => {
    logger.error(`Shard ${shard.id} Fehler:`, error);
  });
});

manager.spawn().then(() => {
  logger.info(`Alle Shards gestartet (${manager.totalShards} Shards).`);
}).catch((error) => {
  logger.error('Sharding-Manager Fehler:', error);
  process.exit(1);
});
