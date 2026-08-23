import type { Server as HttpServer } from 'http';
import type { Server as IOServer } from 'socket.io';
import type { Pool } from 'pg';
import { createDashboardRuntime, scheduleCleanup } from '../../src/dashboard/runtime';

describe('Dashboard runtime lifecycle (NIT-010)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stoppt Startup- und Intervall-Cleanup gemeinsam und idempotent', async () => {
    jest.useFakeTimers();
    const task = jest.fn(async () => undefined);
    const onError = jest.fn();
    const schedule = scheduleCleanup(task, 1_000, 100, onError);

    await jest.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(2);

    schedule.stop();
    schedule.stop();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(task).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('isoliert einen fehlgeschlagenen Cleanup-Lauf ueber onError', async () => {
    jest.useFakeTimers();
    const error = new Error('cleanup failed');
    const task = jest.fn(async () => { throw error; });
    const onError = jest.fn();
    const schedule = scheduleCleanup(task, 1_000, 100, onError);

    await jest.advanceTimersByTimeAsync(100);
    expect(task).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(error);

    await jest.advanceTimersByTimeAsync(1_000);
    expect(task).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(2);

    schedule.stop();
  });

  it('schliesst Ressourcen in sicherer Reihenfolge und nur einmal', async () => {
    const order: string[] = [];
    const cleanup = { stop: jest.fn(() => { order.push('cleanup'); }) };
    const io = {
      close: jest.fn((cb?: () => void) => {
        order.push('io');
        cb?.();
      }),
    } as unknown as IOServer;
    const httpServer = {
      listening: true,
      close: jest.fn((cb?: (error?: Error) => void) => {
        order.push('http');
        cb?.();
      }),
    } as unknown as HttpServer;
    const sessionStore = {
      close: jest.fn(async () => { order.push('store'); }),
    };
    const sessionPool = {
      end: jest.fn(async () => { order.push('pool'); }),
    } as unknown as Pool;

    const runtime = createDashboardRuntime({
      httpServer,
      io,
      sessionStore,
      sessionPool,
      cleanups: [cleanup],
    });

    const first = runtime.stop();
    const second = runtime.stop();
    expect(first).toBe(second);
    await first;

    expect(order).toEqual(['cleanup', 'io', 'http', 'store', 'pool']);
    expect(cleanup.stop).toHaveBeenCalledTimes(1);
    expect(sessionStore.close).toHaveBeenCalledTimes(1);
    expect(sessionPool.end).toHaveBeenCalledTimes(1);
  });

  it('ueberspringt HTTP-close wenn Socket.IO den Listener bereits geschlossen hat', async () => {
    const httpServer = {
      listening: false,
      close: jest.fn(),
    } as unknown as HttpServer;
    const io = {
      close: jest.fn((cb?: () => void) => cb?.()),
    } as unknown as IOServer;
    const sessionStore = { close: jest.fn(async () => undefined) };
    const sessionPool = { end: jest.fn(async () => undefined) } as unknown as Pool;

    const runtime = createDashboardRuntime({
      httpServer,
      io,
      sessionStore,
      sessionPool,
      cleanups: [],
    });

    await runtime.stop();
    expect(httpServer.close).not.toHaveBeenCalled();
  });

  it('exposes the actual listener address for isolated ephemeral-port probes', async () => {
    const listenerAddress = { address: '127.0.0.1', family: 'IPv4', port: 32123 };
    const httpServer = {
      listening: false,
      address: jest.fn(() => listenerAddress),
      close: jest.fn(),
    } as unknown as HttpServer;
    const io = { close: jest.fn((cb?: () => void) => cb?.()) } as unknown as IOServer;
    const sessionStore = { close: jest.fn(async () => undefined) };
    const sessionPool = { end: jest.fn(async () => undefined) } as unknown as Pool;
    const runtime = createDashboardRuntime({
      httpServer,
      io,
      sessionStore,
      sessionPool,
      cleanups: [],
    });

    expect(runtime.address()).toEqual(listenerAddress);
    await runtime.stop();
  });
});
