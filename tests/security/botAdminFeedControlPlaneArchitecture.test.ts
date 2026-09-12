import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (relative: string): string => fs.readFileSync(path.resolve(root, relative), 'utf8');

describe('bot-admin feed control-plane architecture', () => {
  test('mounts the canonical feed adapter before the legacy bot-admin collection router', () => {
    const v2 = read('src/dashboard/routes/v2.ts');
    const canonical = "v2Router.use('/bot-admin/feeds', requireGlobalBotAdminIdentity, requireBotAdmin, guardBotAdminGuildReferences, botAdminFeedsRouter);";
    const legacy = "v2Router.use('/bot-admin', requireGlobalBotAdminIdentity";

    expect(v2).toContain(canonical);
    expect(v2.indexOf(canonical)).toBeLessThan(v2.indexOf(legacy));
  });

  test('keeps one canonical supported type set and centralizes feed mutations/redaction', () => {
    const service = read('src/dashboard/services/feedControlPlane.ts');
    expect(service).toContain("['RSS', 'NEWS', 'TWITCH', 'STEAM', 'YOUTUBE', 'WEBHOOK']");
    expect(service).not.toContain("['RSS', 'NEWS', 'TWITCH', 'TWITTER'");
    expect(service).not.toContain("'CUSTOM', 'WEBHOOK'");
    expect(service).toContain('Legacy-Feed-Typ ${existing.feedType}');
    expect(service).toContain('hasWebhookSecret: feed.webhookSecret != null');
    expect(service).toContain('hasCredentials: feed.credentialsEnc != null');
    expect(service).toContain('updateCanonicalFeed');
    expect(service).toContain('toggleCanonicalFeed');
    expect(service).toContain('deleteCanonicalFeed');

    const adapter = read('src/dashboard/routes/v2/botAdminFeeds.ts');
    expect(adapter).toContain('updateCanonicalFeed');
    expect(adapter).toContain('toggleCanonicalFeed');
    expect(adapter).toContain('deleteCanonicalFeed');
    expect(adapter).toContain('feedToApi');
    expect(adapter).not.toContain('prisma.feed.update');
    expect(adapter).not.toContain('prisma.feed.delete');
  });

  test('keeps guild and bot-admin auth transports separate while sharing domain logic', () => {
    const guildRoute = read('src/dashboard/routes/v2/feeds.ts');
    const botAdminRoute = read('src/dashboard/routes/v2/botAdminFeeds.ts');

    expect(guildRoute).toContain("requireGuildPermission('feeds.manage')");
    expect(botAdminRoute).not.toContain('requireGuildPermission');
    expect(guildRoute).toContain('updateCanonicalFeed');
    expect(botAdminRoute).toContain('updateCanonicalFeed');
  });

  test('uses one canonical FeedsTab for guild and bot-admin transports', () => {
    const feedsTab = read('dashboard-ui/src/components/FeedsTab.tsx');
    const botAdmin = read('dashboard-ui/src/components/BotAdminTab.tsx');

    expect(feedsTab).toContain("export type FeedTransport = 'guild' | 'bot-admin'");
    expect(feedsTab).toContain("transport = 'guild'");
    expect(feedsTab).toContain('/api/v2/bot-admin/feeds');
    expect(feedsTab).toContain("type FeedType = 'RSS' | 'NEWS' | 'TWITCH' | 'STEAM' | 'YOUTUBE' | 'WEBHOOK'");
    expect(feedsTab).not.toContain("'TWITTER'");
    expect(feedsTab).not.toContain("'CUSTOM'");

    expect(botAdmin).toContain("import { FeedsTab } from '@/components/FeedsTab'");
    expect(botAdmin).toContain('<FeedsTab guildId={guildId} canManage={canManage} transport="bot-admin" />');
    expect(botAdmin).not.toContain('function FeedsSection');
    expect(botAdmin).not.toContain('function FeedCreateForm');
    expect(botAdmin).not.toContain("'TWITTER'");
    expect(botAdmin).not.toContain("'CUSTOM'");
  });
});
