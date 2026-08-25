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
    expect(runtime).toContain('nonce: eventNonce(event.id)');
    expect(runtime).toContain('enforceNonce: true');
  });

  it('builds Online List from current ADM presence truth without stale PlayerSession or another Nitrado poller', () => {
    expect(runtime).not.toContain('prisma.playerSession.findMany');
    expect(runtime).toContain('prisma.admSourceCursor.findFirst');
    expect(runtime).toContain('sourceFile: latestCursor.fileIdentity');
    expect(runtime).toContain('AdmEventType.PLAYER_CONNECTED');
    expect(runtime).toContain('AdmEventType.PLAYER_DISCONNECTED');
    expect(runtime).toContain('resolveOnlinePresence(presenceEvents)');
    expect(runtime).toContain('attachCurrentPositions(online, positions)');
    expect(runtime).toContain('playerListNonce(config.id, stateHash, postKey)');
    expect(runtime).toContain('message.edit');
    expect(runtime).not.toContain('new NitradoClient');
    expect(playerList).toContain('🌐 Online List');
    expect(playerList).toContain('Position unbekannt');
  });

  it('supports explicit periodic Online List posts without replacing change-based edits', () => {
    expect(route).toContain('playerListIntervalMinutes');
    expect(route).toContain('ONLINE_LIST_INTERVALS');
    expect(runtime).toContain('periodicDue');
    expect(runtime).toContain('let messageId = periodicDue ? null : config.lastMessageId;');
    expect(runtime).toContain('nextPlayerListPostAt');
  });
});
