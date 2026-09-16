import fs from 'node:fs';
import path from 'node:path';

const route = fs.readFileSync(path.resolve(process.cwd(), 'src/dashboard/routes/v2/killfeed.ts'), 'utf8');
const runtime = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/gameplayFeeds/runtime.ts'), 'utf8');
const playerList = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/gameplayFeeds/playerListEmbed.ts'), 'utf8');

describe('Gameplay feed activation, pacing and Online List architecture gate', () => {
  it('locks activation and advances the ADM cursor to the latest scoped event', () => {
    expect(route).toContain('FOR UPDATE');
    expect(route).toContain('locked[0].isActive === false && parsed.data.isActive === true');
    expect(route).toContain('updateData.cursorCreatedAt = watermark?.createdAt ?? new Date();');
    expect(route).toContain("updateData.cursorEventId = watermark?.id ?? '';");
    expect(route).toContain('guildId: scope.guildId');
    expect(route).toContain('nitradoConnId: resolution.nitradoConnId');
  });

  it('keeps queued deliveries and shapes backlog output per Discord channel across configs', () => {
    expect(runtime).toContain('const DELIVERY_BATCH = 1;');
    expect(runtime).toContain('nextDeliveryAt');
    expect(runtime).toContain('reserveChannelDeliverySlot');
    expect(runtime).toContain('FOR UPDATE');
    expect(runtime).toContain('channelId: config.channelId');
    expect(runtime).not.toContain('gameplayFeedDelivery.deleteMany');
    expect(runtime).toContain('function eventNonce(configId: string, eventId: string)');
    expect(runtime).toContain('gameplay-feed\\u0000${configId}\\u0000${eventId}');
    expect(runtime).toContain('nonce: eventNonce(config.id, event.id)');
    expect(runtime).not.toContain('nonce: eventNonce(event.id)');
    expect(runtime).toContain('enforceNonce: true');
  });

  it('builds Online List from current ADM presence truth without stale PlayerSession or another Nitrado poller', () => {
    expect(runtime).not.toContain('prisma.playerSession.findMany');
    expect(runtime).toContain('prisma.admSourceCursor.findFirst');
    expect(runtime).toContain('AND "sourceFile" = ${latestCursor.fileIdentity}');
    expect(runtime).toContain("'PLAYER_CONNECTED'::\"AdmEventType\"");
    expect(runtime).toContain("'PLAYER_DISCONNECTED'::\"AdmEventType\"");
    expect(runtime).toContain("'PLAYER_POSITION'::\"AdmEventType\"");
    expect(runtime).toContain('resolveOnlinePresence(presenceEvents, positions)');
    expect(runtime).toContain('attachCurrentPositions(online, positions)');
    expect(runtime).toContain('playerListNonce(config.id, stateHash, postKey)');
    expect(runtime).toContain('message.edit');
    expect(runtime).not.toContain('new NitradoClient');
    expect(playerList).toContain('🌐 • Online List');
    expect(playerList).not.toContain('Position unbekannt');
    expect(playerList).toContain('return position ? `• ${name} — ${position}` : `• ${name}`;');
  });

  it('supports explicit periodic Online List posts without replacing change-based edits', () => {
    expect(route).toContain('playerListIntervalMinutes');
    expect(route).toContain('ONLINE_LIST_INTERVALS');
    expect(runtime).toContain('periodicDue');
    expect(runtime).toContain('let messageId = periodicDue ? null : config.lastMessageId;');
    expect(runtime).toContain('nextPlayerListPostAt');
  });

  it('stoppt die Online-List-Ausgabe exakt bei 0 Spielern und laesst sie beim naechsten Spieler sofort neu starten', () => {
    // Explizite Anforderung: bei 'keinen Spieler' auf dem Server soll die
    // Ausgabe gestoppt werden - exakt und lueckenlos - bis zum 1. Spieler,
    // dann unabhaengig vom periodischen Erschein-Zyklus sofort wieder
    // beginnen. Die bestehende Nachricht wird dabei entfernt statt stehen zu
    // bleiben, damit kein veralteter Spielerstand sichtbar bleibt.
    const fn = runtime.slice(
      runtime.indexOf('async function processPlayerListConfig'),
      runtime.indexOf('async function reserveChannelDeliverySlot'),
    );
    expect(fn).toContain('if (entries.length === 0) {');
    expect(fn).toContain('if (config.lastMessageId) await clearPlayerListMessage(config);');
    expect(fn).toContain('lastMessageId: null,');
    expect(fn).toContain('lastStateHash: null,');
    expect(fn).toContain('lastPlayerCount: 0,');
    expect(fn).toContain('return;');
    // Der 0-Spieler-Block muss vor dem stateHash/periodicDue-Zweig liegen und
    // darf diesen nicht ausfuehren (keine neue/aktualisierte Nachricht).
    expect(fn.indexOf('entries.length === 0')).toBeLessThan(fn.indexOf('const stateHash = playerListStateHash'));

    const clearFn = runtime.slice(
      runtime.indexOf('async function clearPlayerListMessage'),
      runtime.indexOf('async function processPlayerListConfig'),
    );
    expect(clearFn).toContain('if (!config.lastMessageId) return;');
    expect(clearFn).toContain('await message.delete().catch(() => undefined);');

    // Da lastMessageId/lastStateHash zurueckgesetzt werden, erzwingt der
    // naechste Tick mit >=1 Spieler stateChanged=true unabhaengig von
    // periodicDue/nextPlayerListPostAt - also sofortigen Neustart.
    expect(fn).toContain("const stateChanged = config.lastStateHash !== stateHash || !config.lastMessageId;");
  });
});
