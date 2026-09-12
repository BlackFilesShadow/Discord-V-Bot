import fs from 'node:fs';
import path from 'node:path';

function read(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), 'utf8');
}

describe('polling feed delivery idempotency architecture', () => {
  test('routes every polling Discord post through the persistent delivery claim', () => {
    const manager = read('src/modules/feeds/feedManagerV2.ts');

    expect(manager).toContain("from './feedDeliveryClaim'");
    expect((manager.match(/await deliverFeedItemOnce\(/g) ?? [])).toHaveLength(4);
    expect(manager).toContain("deliverFeedItemOnce(feed.id, raw.id, () => send(embed))");
    expect(manager).toContain("deliverFeedItemOnce(feed.id, marker, () => send(embed))");
    expect(manager).toContain("deliverFeedItemOnce(feed.id, item.id, () => send(embed))");
    expect(manager).not.toContain('await send(embed);');
  });

  test('keeps webhook delivery separate and cleans only the feed-delivery namespace', () => {
    const helper = read('src/modules/feeds/feedDeliveryClaim.ts');
    const webhook = read('src/modules/feeds/webhookReceiver.ts');

    expect(helper).toContain("const FEED_DELIVERY_PREFIX = 'feed-delivery:'");
    expect(helper).toContain("status: 'PROCESSING'");
    expect(helper).toContain("status: 'DONE'");
    expect(helper).toContain("hash: { startsWith: FEED_DELIVERY_PREFIX }");
    expect(helper).toContain('await releaseClaim(hash)');
    expect(helper).toContain("logAudit('FEED_DELIVERY_FINALIZE_FAILED', 'SECURITY'");
    expect(webhook).toContain('claimReplayKey');
    expect(webhook).toContain('releaseReplayKey');
    expect(helper).not.toContain('webhook:');
  });

  test('runs bounded claim cleanup from the existing normal-feed scheduler only', () => {
    const manager = read('src/modules/feeds/feedManagerV2.ts');
    expect(manager).toContain('await cleanupExpiredFeedDeliveryClaims();');
    expect(manager).not.toContain('gameplayFeeds');
    expect(manager).not.toContain('nitrado');
  });
});
