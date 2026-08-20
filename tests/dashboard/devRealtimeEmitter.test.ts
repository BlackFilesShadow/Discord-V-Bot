import type { Server as IOServer } from 'socket.io';
import {
  emitDevLog,
  sanitizeDevLogLine,
  setIo,
} from '../../src/dashboard/socket/emitter';

describe('DEV realtime log transport', () => {
  afterEach(() => setIo(null));

  it('redigiert Secrets in Freitext und verschachtelten Metadaten vor dem Broadcast', () => {
    const safe = sanitizeDevLogLine({
      ts: 123,
      level: 'info',
      message: 'Authorization: Bearer live-secret-token',
      meta: {
        password: 'super-secret-password',
        nested: {
          token: 'abc123',
          note: 'access_token=another-secret',
        },
      },
    });

    const serialized = JSON.stringify(safe);
    expect(serialized).not.toContain('live-secret-token');
    expect(serialized).not.toContain('super-secret-password');
    expect(serialized).not.toContain('abc123');
    expect(serialized).not.toContain('another-secret');
    expect(serialized).toContain('[REDACTED]');
  });

  it('bleibt bei zyklischen/BigInt-Metadaten serialisierbar und fail-closed', () => {
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

  it('emittiert niemals die rohe Log-Zeile', () => {
    const emit = jest.fn();
    const of = jest.fn(() => ({ emit }));
    setIo({ of } as unknown as IOServer);

    emitDevLog({
      ts: 789,
      level: 'warn',
      message: 'password=do-not-leak',
      meta: { authorization: 'Bearer also-do-not-leak' },
    });

    expect(of).toHaveBeenCalledWith('/dev');
    expect(emit).toHaveBeenCalledTimes(1);
    const [, payload] = emit.mock.calls[0] as [string, unknown];
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('do-not-leak');
    expect(serialized).not.toContain('also-do-not-leak');
  });
});
