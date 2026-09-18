const requestMock = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: () => ({ request: requestMock }),
  },
}));

class FakeCircuitOpen extends Error {}
jest.mock('../../src/modules/nitrado/circuitBreaker', () => {
  const breaker = { preflight: jest.fn(), recordFailure: jest.fn(), recordSuccess: jest.fn() };
  return {
    __esModule: true,
    getNitradoBreaker: () => breaker,
    opClassForMethod: (method: string) => (method === 'GET' ? 'READ' : 'WRITE'),
    NitradoCircuitOpenError: FakeCircuitOpen,
  };
});
jest.mock('../../src/utils/logger', () => ({
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import { NitradoApiError, NitradoClient } from '../../src/modules/nitrado/nitradoClient';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Nitrado task scheduler client', () => {
  it('reads and strictly normalizes the real /tasks response', async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        data: {
          tasks: [{
            id: 17,
            minute: 0,
            hour: 4,
            day: '*',
            month: '*',
            weekday: '*',
            next_run: '2026-09-19 04:00:00',
            last_run: '2026-09-18 04:00:00',
            timezone: 'Europe/Berlin',
            action_method: 'game_server_restart',
            action_data: null,
          }],
        },
      },
    });

    const rows = await new NitradoClient('token-1234').listTasks('12345');

    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/services/12345/tasks',
    }));
    expect(rows).toEqual([{
      id: 17,
      minute: '0',
      hour: '4',
      day: '*',
      month: '*',
      weekday: '*',
      next_run: '2026-09-19 04:00:00',
      last_run: '2026-09-18 04:00:00',
      timezone: 'Europe/Berlin',
      action_method: 'game_server_restart',
      action_data: null,
    }]);
  });

  it('fails closed on malformed task rows instead of guessing an action or ID', async () => {
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: { tasks: [{ id: 'not-a-number', action_method: '' }] } },
    });

    await expect(new NitradoClient('token-1234').listTasks('12345'))
      .rejects.toBeInstanceOf(NitradoApiError);
  });

  it('reads the Nitrado task action catalog from /tasks/list', async () => {
    const catalog = [{ action_method: 'game_server_restart' }];
    requestMock.mockResolvedValue({
      status: 200,
      headers: {},
      data: { data: { tasks: catalog } },
    });

    await expect(new NitradoClient('token-1234').getTaskActionCatalog('12345'))
      .resolves.toEqual(catalog);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({
      method: 'GET',
      url: '/services/12345/tasks/list',
    }));
  });

  it('creates concrete daily tasks with the official scheduler fields', async () => {
    requestMock.mockResolvedValue({ status: 200, headers: {}, data: { status: 'success' } });

    await new NitradoClient('token-1234').createTask('12345', {
      hour: '04',
      minute: '15',
      day: '*',
      month: '*',
      weekday: '*',
      actionMethod: 'game_server_restart',
    });

    const call = requestMock.mock.calls[0][0] as {
      method: string;
      url: string;
      data: string;
      headers: Record<string, string>;
    };
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/services/12345/tasks');
    const params = new URLSearchParams(call.data);
    expect(Object.fromEntries(params.entries())).toEqual({
      minute: '15',
      hour: '04',
      day: '*',
      month: '*',
      weekday: '*',
      action_method: 'game_server_restart',
    });
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  it('treats a confirmed 404 on DELETE as idempotent success and still rejects other client errors', async () => {
    requestMock.mockResolvedValueOnce({ status: 404, headers: {}, data: { message: 'not found' } });
    await expect(new NitradoClient('token-1234').deleteTask('12345', 17)).resolves.toBeUndefined();

    requestMock.mockResolvedValueOnce({ status: 403, headers: {}, data: { message: 'forbidden' } });
    await expect(new NitradoClient('token-1234').deleteTask('12345', 18))
      .rejects.toMatchObject({ status: 403 });
  });
});
