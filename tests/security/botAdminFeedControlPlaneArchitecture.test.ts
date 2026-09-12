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

  test('keeps legacy types readable but blocks them from the canonical supported set', () => {
    const service = read('src/dashboard/services/feedControlPlane.ts');
    expect(service).toContain("['RSS', 'NEWS', 'TWITCH', 'STEAM', 'YOUTUBE', 'WEBHOOK']");
    expect(service).not.toContain("['RSS', 'NEWS', 'TWITCH', 'TWITTER'");
    expect(service).not.toContain("'CUSTOM', 'WEBHOOK'");

    const adapter = read('src/dashboard/routes/v2/botAdminFeeds.ts');
    expect(adapter).toContain('Legacy-Feed-Typ');
    expect(adapter).toContain('hasWebhookSecret: webhookSecret != null');
    expect(adapter).toContain('hasCredentials: credentialsEnc != null');
  });
});
