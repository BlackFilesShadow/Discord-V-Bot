import type { Server as IOServer } from 'socket.io';
import {
  emitDevLog,
  sanitizeDevLogLine,
  setIo,
} from '../../src/dashboard/socket/emitter';

describe('DEV realtime log transport', () => {
  afterEach(() => setIo(null));

  it('redigiert sensible Werte in Freitext und verschachtelten Metadaten vor dem Broadcast', () => {
    const safe = sanitizeDevLogLine({
      ts: 123,
      level: 'info',
      message: 'Authorization: Bearer example-marker',
      meta: {
        password: 'pw-marker',
        nested: {
          token: 'token-marker',
          note: 'access_token=value-marker',
        },
      },
    });

    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('example-marker');
    expect(serialized).not.toContain('pw-marker');
    expect(serialized).not.toContain('token-marker');
    expect(serialized).not.toContain('value-marker');
    expect(serialized).toContain('[REDACTED]');
  });

  it('bleibt bei zyklischen und BigInt-Metadaten serialisierbar und fail-closed', () => {
    const cyclic: Record<string, unknown> = { count: 12n };
    cyclic.self = cyclic;

    const safe = sanitizeDevLogLine({
      ts: 456,
      level: 'debug',
      message: 'cycle test',
      meta: { cyclic },
    });

    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(JSON.stringify(safe)).toContain('[CIRCULAR]');
    expect(JSON.stringify(safe)).toContain('12');
  });

  it('laesst weder unbekannte Level noch werfende Getter den Transport umgehen', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'field', {
      enumerable: true,
      get: () => { throw new Error('getter-marker'); },
    });

    const safe = sanitizeDevLogLine({
      ts: 654,
      level: 'unknown-level-marker',
      message: 'safe message',
      meta: { hostile },
    });

    const serialized = JSON.stringify(safe);
    expect(safe.level).toBe('info');
    expect(serialized).not.toContain('unknown-level-marker');
    expect(serialized).not.toContain('getter-marker');
    expect(serialized).toContain('[TRUNCATED]');
  });

  it('emittiert niemals die rohe Log-Zeile', () => {
    const emit = jest.fn();
    const of = jest.fn(() => ({ emit }));
    setIo({ of } as unknown as IOServer);

    emitDevLog({
      ts: 789,
      level: 'warn',
      message: 'password=broadcast-marker',
      meta: { authorization: 'Bearer auth-marker' },
    });

    expect(of).toHaveBeenCalledWith('/dev');
    expect(emit).toHaveBeenCalledTimes(1);
    const [, payload] = emit.mock.calls[0] as [string, unknown];
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('broadcast-marker');
    expect(serialized).not.toContain('auth-marker');
  });
});
