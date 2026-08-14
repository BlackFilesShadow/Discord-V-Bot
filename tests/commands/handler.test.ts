import { loadCommands } from '../../src/commands/handler';
import { Collection } from 'discord.js';
import { Command, ExtendedClient } from '../../src/types';

process.env.DISCORD_TOKEN = 'test-token';
process.env.DISCORD_CLIENT_ID = 'test-client-id';
process.env.DISCORD_CLIENT_SECRET = 'test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.SESSION_SECRET = 'test-session-secret';

function createMockClient(): ExtendedClient {
  return {
    commands: new Collection<string, Command>(),
  } as unknown as ExtendedClient;
}

describe('Command Handler (Sektion 5)', () => {
  it('sollte Commands aus user/ und admin/ laden', async () => {
    const client = createMockClient();
    await loadCommands(client);
    expect(client.commands.size).toBeGreaterThan(0);
  });

  it('sollte Default-Export-Commands laden', async () => {
    const client = createMockClient();
    await loadCommands(client);
    expect(client.commands.has('register')).toBe(true);
    expect(client.commands.has('help')).toBe(true);
  });

  it('sollte Named-Export-Commands laden (moderation)', async () => {
    const client = createMockClient();
    await loadCommands(client);
    expect(client.commands.has('kick')).toBe(true);
    expect(client.commands.has('ban')).toBe(true);
    expect(client.commands.has('mute')).toBe(true);
    expect(client.commands.has('warn')).toBe(true);
    expect(client.commands.has('appeal')).toBe(true);
  });

  it('sollte Admin-Commands laden', async () => {
    const client = createMockClient();
    await loadCommands(client);
    expect(client.commands.has('admin-list-pakete')).toBe(true);
    expect(client.commands.has('admin-config')).toBe(true);
    expect(client.commands.has('admin-stats')).toBe(true);
    expect(client.commands.has('admin-monitor')).toBe(true);
  });

  it('sollte Permission-, Server-Ban- und Phase-8-Commands vollstaendig laden', async () => {
    const client = createMockClient();
    await loadCommands(client);

    expect(client.commands.has('perm-add')).toBe(true);
    expect(client.commands.has('perm-remove')).toBe(true);
    expect(client.commands.has('perms')).toBe(true);

    expect(client.commands.has('server-ban')).toBe(true);
    expect(client.commands.has('server-unban')).toBe(true);
    expect(client.commands.has('server-ban-list')).toBe(true);

    expect(client.commands.has('add-money')).toBe(true);
    expect(client.commands.has('remove-money')).toBe(true);
    expect(client.commands.has('force-link')).toBe(true);
    expect(client.commands.has('force-unlink')).toBe(true);
    expect(client.commands.has('confirm-action')).toBe(true);
  });

  it('sollte jeder Command eine execute-Funktion haben', async () => {
    const client = createMockClient();
    await loadCommands(client);
    client.commands.forEach((cmd: Command) => {
      expect(typeof cmd.execute).toBe('function');
    });
  });

  it('sollte jeder Command gültige SlashCommand-Daten haben', async () => {
    const client = createMockClient();
    await loadCommands(client);
    client.commands.forEach((cmd: Command) => {
      expect(cmd.data).toBeDefined();
      expect(cmd.data.name).toBeTruthy();
    });
  });
});