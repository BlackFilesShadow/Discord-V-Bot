import type { Server as IOServer } from 'socket.io';

const mockUserFindUnique = jest.fn();
const mockDevSessionFindFirst = jest.fn();
const mockDevSessionUpdateMany = jest.fn();
const mockIsEligible = jest.fn((discordId: string, role: string) => discordId === 'owner-discord' && role === 'DEVELOPER');

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    user: { findUnique: (...args: unknown[]) => mockUserFindUnique(...args) },
    devSession: {
      findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args),
      updateMany: (...args: unknown[]) => mockDevSessionUpdateMany(...args),
    },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
  },
}));

jest.mock('../../src/dashboard/clientRegistry', () => ({
  __esModule: true,
  tryGetDashboardClient: jest.fn(() => null),
}));

jest.mock('../../src/dashboard/socket/emitter', () => ({
  __esModule: true,
  emitDevLog: jest.fn(),
}));

jest.mock('../../src/modules/auth/globalDeveloperIdentity', () => ({
  __esModule: true,
  isGlobalDeveloperEligible: (...args: [string, string]) => mockIsEligible(...args),
}));

import { registerDevNamespace } from '../../src/dashboard/socket/dev';

type Middleware = (socket: FakeSocket, next: (error?: Error) => void) => Promise<void>;

interface FakeSocket {
  id: string;
  request: { session?: { userId?: string; discordId?: string; role?: string } };
  data: Record<string, unknown>;
  emit: jest.Mock;
  on: jest.Mock;
  disconnect: jest.Mock;
}

function makeSocket(role = 'DEVELOPER'): FakeSocket {
  return {
    id: 'socket-1',
    request: { session: { userId: 'user-1', discordId: 'owner-discord', role } },
    data: {},
    emit: jest.fn(),
    on: jest.fn(),
    disconnect: jest.fn(),
  };
}

function setupNamespace() {
  let middleware: Middleware | null = null;
  const sockets = new Map<string, FakeSocket>();
  const ns = {
    use: jest.fn((fn: Middleware) => { middleware = fn; }),
    on: jest.fn(),
    sockets,
    emit: jest.fn(),
  };
  const io = { of: jest.fn(() => ns) } as unknown as IOServer;
  registerDevNamespace(io);
  return { ns, getMiddleware: () => middleware };
}

describe('DEV socket authorization lifecycle', () => {
  beforeAll(() => jest.useFakeTimers());
  afterAll(() => jest.useRealTimers());

  beforeEach(() => {
    mockUserFindUnique.mockReset();
    mockDevSessionFindFirst.mockReset();
    mockDevSessionUpdateMany.mockReset();
    mockIsEligible.mockClear();
    mockDevSessionUpdateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('verweigert einen stale DEVELOPER-Handshake, wenn der DB-User fehlt', async () => {
    mockUserFindUnique.mockResolvedValue(null);
    const { getMiddleware } = setupNamespace();
    const socket = makeSocket('DEVELOPER');
    const next = jest.fn();

    await getMiddleware()!(socket, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('global DEVELOPER identity') }));
    expect(mockDevSessionFindFirst).not.toHaveBeenCalled();
    expect(mockDevSessionUpdateMany).toHaveBeenCalledTimes(1);
  });

  it('bindet einen erfolgreichen Handshake an die exakte aktive DevSession', async () => {
    mockUserFindUnique.mockResolvedValue({ role: 'DEVELOPER' });
    mockDevSessionFindFirst.mockResolvedValue({ id: 'dev-session-1' });
    const { getMiddleware } = setupNamespace();
    const socket = makeSocket();
    const next = jest.fn();

    await getMiddleware()!(socket, next);

    expect(next).toHaveBeenCalledWith();
    expect(socket.data).toEqual(expect.objectContaining({
      devUserId: 'user-1',
      devUserDiscordId: 'owner-discord',
      devSessionId: 'dev-session-1',
    }));
  });

  it('trennt beim spaeteren Rollenentzug und widerruft die Step-up-Session gegen spaetere Wiederbelebung', async () => {
    mockUserFindUnique.mockResolvedValue({ role: 'USER' });
    const { ns } = setupNamespace();
    const socket = makeSocket();
    socket.data = {
      devUserId: 'user-1',
      devUserDiscordId: 'owner-discord',
      devSessionId: 'dev-session-1',
    };
    ns.sockets.set(socket.id, socket);

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.disconnect).toHaveBeenCalledWith(true);
    expect(mockDevSessionFindFirst).not.toHaveBeenCalled();
    expect(mockDevSessionUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ userDiscordId: 'owner-discord', revokedAt: null }),
      data: expect.objectContaining({ revokedAt: expect.any(Date) }),
    }));
  });

  it('trennt bei widerrufener/abgelaufener exakt gebundener Session und akzeptiert keine Ersatz-Session', async () => {
    mockUserFindUnique.mockResolvedValue({ role: 'DEVELOPER' });
    mockDevSessionFindFirst.mockResolvedValue(null);
    const { ns } = setupNamespace();
    const socket = makeSocket();
    socket.data = {
      devUserId: 'user-1',
      devUserDiscordId: 'owner-discord',
      devSessionId: 'old-session',
    };
    ns.sockets.set(socket.id, socket);

    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockDevSessionFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'old-session', userDiscordId: 'owner-discord', revokedAt: null }),
    }));
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});
