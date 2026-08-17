import fs from 'node:fs';
import path from 'node:path';

const indexSource = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
const readySource = fs.readFileSync(path.resolve(process.cwd(), 'src/events/ready.ts'), 'utf8');

describe('Discord runtime production wiring invariants', () => {
  it('verwendet den zentralen Safe-Event-Registrar statt direkter Domain-Event-Schleife', () => {
    expect(indexSource).toContain("import { installDiscordLifecycleObservers, registerBotEventsSafely } from './runtime/discordRuntime';");
    expect(indexSource).toContain('registerBotEventsSafely(client, events);');
    expect(indexSource).not.toContain('for (const event of events)');

    const safeRegister = indexSource.indexOf('registerBotEventsSafely(client, events);');
    const login = indexSource.indexOf('await client.login(config.discord.token);');
    expect(safeRegister).toBeGreaterThanOrEqual(0);
    expect(login).toBeGreaterThan(safeRegister);
  });

  it('installiert Gateway-Lifecycle-Observer vor Login und stoppt sie vor Client-Destroy', () => {
    const install = indexSource.indexOf('const discordLifecycle = installDiscordLifecycleObservers(client);');
    const login = indexSource.indexOf('await client.login(config.discord.token);');
    const shutdownStop = indexSource.lastIndexOf('discordLifecycle.stop();');
    const destroy = indexSource.lastIndexOf('await client.destroy();');

    expect(install).toBeGreaterThanOrEqual(0);
    expect(login).toBeGreaterThan(install);
    expect(shutdownStop).toBeGreaterThan(login);
    expect(destroy).toBeGreaterThan(shutdownStop);
  });

  it('stoppt alle aus ClientReady gestarteten In-Memory-Runtimes symmetrisch', () => {
    expect(indexSource).toContain("import readyEvent, { stopReadyRuntime } from './events/ready';");
    expect(indexSource).toContain('stopReadyRuntime();');

    expect(readySource).toContain('export function stopReadyRuntime(): void');
    expect(readySource).toContain('clearInterval(gaugeTimer);');
    expect(readySource).toContain('clearInterval(providerCooldownTimer);');
    expect(readySource).toContain('stopMemberSyncScheduler();');
    expect(readySource).toContain('stopAuditLogRetentionScheduler();');
    expect(readySource).toContain('stopAllLeaderboardFeeds();');
  });
});
