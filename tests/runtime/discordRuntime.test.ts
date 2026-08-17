import { EventEmitter } from 'node:events';
import type { BotEvent } from '../../src/types';
import {
  installDiscordLifecycleObservers,
  registerBotEventsSafely,
} from '../../src/runtime/discordRuntime';

function event(name: string, once = false, execute = jest.fn(async () => undefined)): BotEvent {
  return { name, once, execute };
}

describe('Discord runtime event registration', () => {
  it('registriert Domain-Events pro Client exakt einmal', () => {
    const client = new EventEmitter();
    const events = [event('alpha'), event('beta', true)];

    registerBotEventsSafely(client, events);
    registerBotEventsSafely(client, events);

    expect(client.listenerCount('alpha')).toBe(1);
    expect(client.listenerCount('beta')).toBe(1);
  });

  it('validiert doppelte Eventnamen vor dem ersten Listener-Side-Effect und vergiftet keinen Retry', () => {
    const client = new EventEmitter();
    const duplicate = [event('same'), event('same')];

    expect(() => registerBotEventsSafely(client, duplicate)).toThrow('Discord-Event doppelt registriert: same');
    expect(client.listenerCount('same')).toBe(0);

    expect(() => registerBotEventsSafely(client, [event('clean')])).not.toThrow();
    expect(client.listenerCount('clean')).toBe(1);
  });

  it('haelt once-Semantik ein und kapselt asynchrone Handler', async () => {
    const client = new EventEmitter();
    const execute = jest.fn(async () => undefined);

    registerBotEventsSafely(client, [event('ready-once', true, execute)]);
    client.emit('ready-once', 'first');
    client.emit('ready-once', 'second');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith('first');
  });
});

describe('Discord gateway lifecycle observers', () => {
  const lifecycleEvents = [
    'error',
    'warn',
    'shardDisconnect',
    'shardReconnecting',
    'shardReady',
    'shardResume',
    'shardError',
  ] as const;

  it('installiert Observer idempotent und entfernt sie beim Shutdown vollstaendig', () => {
    const client = new EventEmitter();

    const first = installDiscordLifecycleObservers(client);
    const second = installDiscordLifecycleObservers(client);
    expect(second).toBe(first);

    for (const name of lifecycleEvents) expect(client.listenerCount(name)).toBe(1);

    first.stop();
    first.stop();
    for (const name of lifecycleEvents) expect(client.listenerCount(name)).toBe(0);
  });

  it('kann nach einem sauberen Stop neu installiert werden', () => {
    const client = new EventEmitter();
    const first = installDiscordLifecycleObservers(client);
    first.stop();

    const second = installDiscordLifecycleObservers(client);
    expect(second).not.toBe(first);
    for (const name of lifecycleEvents) expect(client.listenerCount(name)).toBe(1);
    second.stop();
  });
});
