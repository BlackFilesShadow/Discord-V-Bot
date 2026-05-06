/**
 * Live-E2E: Killfeed-Pipeline gegen einen echten Test-Bot + Test-Guild.
 *
 * SKIP-BY-DEFAULT — siehe tests/e2e-live/README.md fuer Aktivierung.
 *
 * Fluss:
 *   1. Synthetisches ADM-Log generieren (1 connect + 1 disconnect)
 *   2. parseAdm() dagegen laufen lassen
 *   3. Erwartung: genau 1 Session, korrekte Dauer, korrekter steam64+name
 *   4. Optional (wenn Discord-Client bereit): Embed in Test-Channel posten und
 *      verifizieren, dass die Nachricht ankommt (Round-trip via Discord-API).
 */

import { parseAdm } from '../../src/modules/nitrado/admParser';

const LIVE = process.env.ENABLE_LIVE_E2E === '1';
const HAS_BOT =
  !!process.env.DISCORD_TEST_BOT_TOKEN &&
  !!process.env.TEST_GUILD_ID &&
  !!process.env.TEST_KILLFEED_CHANNEL_ID;

const describeLive = LIVE ? describe : describe.skip;
const describeBot = LIVE && HAS_BOT ? describe : describe.skip;

function makeAdm(steam64: string, name: string): string {
  return [
    'AdminLog started on 2026-05-06 at 18:00:00',
    `18:05:11 | Player "${name}" (id=${steam64} pos=<1,2,3>) connected`,
    `18:42:00 | Player "${name}" (id=${steam64} pos=<4,5,6>) disconnected`,
  ].join('\n');
}

describeLive('Killfeed live-pipeline (parser only)', () => {
  it('parst eine vollstaendige Session korrekt', () => {
    const sessions = parseAdm(makeAdm('76561198000000001', 'TestPlayer1'));
    expect(sessions).toHaveLength(1);
    const s = sessions[0];
    expect(s.steam64).toBe('76561198000000001');
    expect(s.playerName).toBe('TestPlayer1');
    expect(s.durationMinutes).toBeGreaterThan(36);
    expect(s.durationMinutes).toBeLessThan(38);
  });
});

describeBot('Killfeed live-pipeline (Discord round-trip)', () => {
  // Lazy-import damit discord.js NICHT geladen wird, wenn Suite skipped ist
  // (vermeidet erzwungene devDeps in CI-Pfaden). `any` umgeht das duale
  // Resolution-Mode-Problem zwischen ESM-Type-Import und CJS-runtime-Import.
  let discord: any;
  let client: any;

  beforeAll(async () => {
    discord = await import('discord.js');
    client = new discord.Client({
      intents: [discord.GatewayIntentBits.Guilds, discord.GatewayIntentBits.GuildMessages],
    });
    await client.login(process.env.DISCORD_TEST_BOT_TOKEN!);
    // Auf ready warten (max 15 s)
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error('client not ready in 15s')), 15_000);
      client.once('ready', () => { clearTimeout(t); res(); });
    });
  }, 30_000);

  afterAll(async () => {
    if (client) await client.destroy();
  });

  it('postet ein Killfeed-Embed in den Test-Channel und kann es wieder lesen', async () => {
    const channelId = process.env.TEST_KILLFEED_CHANNEL_ID!;
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('send' in channel)) {
      throw new Error(`Channel ${channelId} ist kein TextChannel`);
    }

    const marker = `__live_e2e__${Date.now()}`;
    const embed = new discord.EmbedBuilder()
      .setTitle('Killfeed-E2E')
      .setDescription(marker)
      .setColor(0x00ff00);

    const sent = await channel.send({ embeds: [embed.toJSON()] });
    expect(sent.id).toBeTruthy();

    // Re-fetch und Marker verifizieren
    const fetched = await channel.messages.fetch(sent.id);
    const desc = fetched.embeds?.[0]?.description ?? '';
    expect(desc).toBe(marker);

    // Aufraeumen
    await fetched.delete().catch(() => { /* best-effort */ });
  }, 30_000);
});
