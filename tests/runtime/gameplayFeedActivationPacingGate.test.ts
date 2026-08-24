import fs from 'node:fs';
import path from 'node:path';

const route = fs.readFileSync(path.resolve(process.cwd(), 'src/dashboard/routes/v2/killfeed.ts'), 'utf8');
const runtime = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/gameplayFeeds/runtime.ts'), 'utf8');
const playerList = fs.readFileSync(path.resolve(process.cwd(), 'src/modules/gameplayFeeds/playerListEmbed.ts'), 'utf8');

describe('Gameplay feed activation, pacing and Player List architecture gate', () => {
  it('locks activation and advances the ADM cursor to the latest scoped event', () => {
    expect(route).toContain('FOR UPDATE');
    expect(route).toContain('locked[0].isActive === false && parsed.data.isActive === true');
    expect(route).toContain('updateData.cursorCreatedAt = watermark?.createdAt ?? new Date();');
    expect(route).toContain("updateData.cursorEventId = watermark?.id ?? '';");
    expect(route).toContain('guildId: scope.guildId');
    expect(route).toContain('nitradoConnId: resolution.nitradoConnId');
  });

  it('keeps queued deliveries and shapes backlog output to one persisted delivery per tick', () => {
    expect(runtime).toContain('const DELIVERY_BATCH = 1;');
    expect(runtime).toContain('nextDeliveryAt');
    expect(runtime).not.toContain('gameplayFeedDelivery.deleteMany');
    expect(runtime).toContain('nonce: eventNonce(event.id)');
    expect(runtime).toContain('enforceNonce: true');
  });

  it('builds Player List only from PlayerSession and AdmEvent, without another Nitrado poller', () => {
    expect(runtime).toContain('prisma.playerSession.findMany');
    expect(runtime).toContain("'PLAYER_POSITION'::\"AdmEventType\"");
    expect(runtime).toContain('message.edit');
    expect(runtime).not.toContain('new NitradoClient');
    expect(playerList).toContain('Position unbekannt');
  });
});
