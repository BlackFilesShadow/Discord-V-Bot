const requestMock = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ request: requestMock }) },
}));

jest.mock('../../src/modules/nitrado/circuitBreaker', () => {
  const breaker = { preflight: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn() };
  return {
    __esModule: true,
    getNitradoBreaker: () => breaker,
    opClassForMethod: (method: string) => (method === 'GET' ? 'READ' : 'WRITE'),
    nitradoBreaker: breaker,
    NitradoCircuitOpenError: class NitradoCircuitOpenError extends Error {},
  };
});

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { NitradoClient } from '../../src/modules/nitrado/nitradoClient';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Nitrado Task Scheduler client contract', () => {
  it('parses the real task envelope fail-closed and preserves concrete scheduler fields', async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        data: {
          tasks: [{
            id: 17,
            minute: 15,
            hour: 4,
            day: '*',
            month: '*',
            weekday: '*',
            next_run: '2026-09-18T04:15:00+02:00',
            last_run: '2026-09-18T00:15:00+02:00',
            timezone: 'Europe/Berlin',
            action_method: 'game_server_restart',
            action_data: null,
          }],
        },
      },
    });

    const client = new NitradoClient('token-1234');
    await expect(client.listTasks('12345')).resolves.toEqual([{
      id: 17,
      minute: '15',
      hour: '4',
      day: '*',
      month: '*',
      weekday: '*',
      next_run: '2026-09-18T04:15:00+02:00',
      last_run: '2026-09-18T00:15:00+02:00',
      timezone: 'Europe/Berlin',
      action_method: 'game_server_restart',
      action_data: null,
    }]);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/services/12345/tasks',
    }));
  });

  it('rejects malformed task rows instead of treating the remote list as empty', async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: { tasks: [{ id: null, action_method: '' }] } },
    });

    const client = new NitradoClient('token-1234');
    await expect(client.listTasks('12345')).rejects.toMatchObject({
      name: 'NitradoApiError',
      endpoint: '/services/12345/tasks',
    });
  });

  it('creates a concrete daily restart through form-encoded Nitrado task fields', async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { data: {} } });

    const client = new NitradoClient('token-1234');
    await client.createTask('12345', {
      hour: '4',
      minute: '15',
      day: '*',
      month: '*',
      weekday: '*',
      actionMethod: 'game_server_restart',
    });

    const call = requestMock.mock.calls[0]?.[0] as {
      method: string;
      url: string;
      data: string;
      headers: Record<string, string>;
    };
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/services/12345/tasks');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(new URLSearchParams(call.data)).toEqual(new URLSearchParams({
      minute: '15',
      hour: '4',
      day: '*',
      month: '*',
      weekday: '*',
      action_method: 'game_server_restart',
    }));
  });

  it('treats a delete 404 as idempotent success because the task is already absent', async () => {
    requestMock.mockResolvedValue({
      status: 404,
      headers: {},
      data: { message: 'not found' },
    });

    const client = new NitradoClient('token-1234');
    await expect(client.deleteTask('12345', 17)).resolves.toBeUndefined();
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'DELETE',
      url: '/services/12345/tasks/17',
    }));
  });

  it('rejects invalid task ids before any remote request', async () => {
    const client = new NitradoClient('token-1234');
    await expect(client.deleteTask('12345', 0)).rejects.toMatchObject({
      name: 'NitradoApiError',
    });
    expect(requestMock).not.toHaveBeenCalled();
  });
});
