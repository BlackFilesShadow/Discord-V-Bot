/**
 * Nitrado-1L: Der read-only Mirror muss dieselbe bounded Fehlersemantik wie
 * der kanonische Nitrado-Pfad besitzen. Besonders wichtig: ein dauerhaftes
 * 429 darf seinen Status nicht verlieren und Retry-After darf nicht unbounded
 * schlafen. API-GET und signierter Download-Hop werden getrennt abgedeckt.
 */
const requestMock = jest.fn();
const getMock = jest.fn();

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    create: () => ({ request: requestMock }),
    get: getMock,
  },
}));

jest.mock('../../src/utils/logger', () => ({
  __esModule: true,
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

import {
  NitradoReadClient,
  parseMirrorRetryAfterMs,
} from '../../src/modules/nitrado/mirror/readClient';

beforeEach(() => {
  jest.clearAllMocks();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('Nitrado-1L — Mirror Retry-After', () => {
  it('interpretiert Sekunden', () => {
    expect(parseMirrorRetryAfterMs('5')).toBe(5000);
  });

  it('interpretiert ein HTTP-Datum in der Zukunft', () => {
    const future = new Date(Date.now() + 4000).toUTCString();
    const ms = parseMirrorRetryAfterMs(future);
    expect(ms).toBeGreaterThan(1000);
    expect(ms).toBeLessThanOrEqual(5000);
  });

  it('deckelt Remote-Werte und nutzt fuer fehlende Header einen bounded Default', () => {
    expect(parseMirrorRetryAfterMs('99999')).toBe(30_000);
    expect(parseMirrorRetryAfterMs(undefined)).toBe(2000);
    expect(parseMirrorRetryAfterMs('', 1000)).toBe(1000);
  });

  it('klemmt vergangene HTTP-Daten auf 0', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseMirrorRetryAfterMs(past)).toBe(0);
  });
});

describe('Nitrado-1L — Mirror API-GET Taxonomy', () => {
  it.each([401, 403, 404])('reicht permanenten HTTP %s ohne Retry mit echtem Status weiter', async status => {
    requestMock.mockResolvedValue({ status, headers: {}, data: { message: `HTTP ${status}` } });

    const client = new NitradoReadClient('token-1234');
    await expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoReadError',
      status,
      endpoint: '/services',
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('behaelt nach dauerhaftem 429 den Status 429', async () => {
    jest.useFakeTimers();
    requestMock.mockResolvedValue({ status: 429, headers: { 'retry-after': '0' }, data: {} });

    const client = new NitradoReadClient('token-1234');
    const expectation = expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoReadError',
      status: 429,
      endpoint: '/services',
    });
    await jest.runAllTimersAsync();
    await expectation;
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('erholt sich nach einem transienten 429', async () => {
    jest.useFakeTimers();
    requestMock
      .mockResolvedValueOnce({ status: 429, headers: { 'retry-after': '0' }, data: {} })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { data: { services: [] } } });

    const client = new NitradoReadClient('token-1234');
    const promise = client.listServices();
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toEqual([]);
    expect(requestMock).toHaveBeenCalledTimes(2);
  });

  it('retryt 5xx bounded und behaelt beim letzten Versuch den Status', async () => {
    jest.useFakeTimers();
    requestMock.mockResolvedValue({ status: 503, headers: {}, data: { message: 'unavailable' } });

    const client = new NitradoReadClient('token-1234');
    const expectation = expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoReadError',
      status: 503,
      endpoint: '/services',
    });
    await jest.runAllTimersAsync();
    await expectation;
    expect(requestMock).toHaveBeenCalledTimes(3);
  });

  it('retryt auch einen Transport-Timeout bounded statt sofort einen Snapshot-Teilfehler zu erzeugen', async () => {
    jest.useFakeTimers();
    const timeout = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    requestMock.mockRejectedValue(timeout);

    const client = new NitradoReadClient('token-1234');
    const expectation = expect(client.listServices()).rejects.toMatchObject({
      name: 'NitradoReadError',
      status: null,
      endpoint: '/services',
      message: 'timeout',
    });
    await jest.runAllTimersAsync();
    await expectation;
    expect(requestMock).toHaveBeenCalledTimes(3);
  });
});

describe('Nitrado-1L — signierter Download-Hop', () => {
  const metadata = {
    status: 200,
    headers: {},
    data: { data: { token: { url: 'https://signed.invalid/file' } } },
  };

  it('behaelt auch beim Download nach dauerhaftem 429 den Status', async () => {
    jest.useFakeTimers();
    requestMock.mockResolvedValue(metadata);
    getMock.mockResolvedValue({ status: 429, headers: { 'retry-after': '0' }, data: new ArrayBuffer(0) });

    const client = new NitradoReadClient('token-1234');
    const expectation = expect(client.downloadFile('123', '/logs/server.ADM', 1024)).rejects.toMatchObject({
      name: 'NitradoReadError',
      status: 429,
      endpoint: '/logs/server.ADM',
    });
    await jest.runAllTimersAsync();
    await expectation;
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(getMock).toHaveBeenCalledTimes(3);
  });

  it('retryt einen 5xx-Download und liefert den Buffer nach Folge-Erfolg', async () => {
    jest.useFakeTimers();
    requestMock.mockResolvedValue(metadata);
    const payload = new Uint8Array([1, 2, 3]).buffer;
    getMock
      .mockResolvedValueOnce({ status: 503, headers: {}, data: new ArrayBuffer(0) })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: payload });

    const client = new NitradoReadClient('token-1234');
    const promise = client.downloadFile('123', '/logs/server.ADM', 1024);
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toEqual(Buffer.from([1, 2, 3]));
    expect(getMock).toHaveBeenCalledTimes(2);
  });

  it('retryt Download-Timeouts bounded und endet mit einem gescrubbt klassifizierbaren Read-Error', async () => {
    jest.useFakeTimers();
    requestMock.mockResolvedValue(metadata);
    const timeout = Object.assign(new Error('signed timeout'), { code: 'ECONNABORTED' });
    getMock.mockRejectedValue(timeout);

    const client = new NitradoReadClient('token-1234');
    const expectation = expect(client.downloadFile('123', '/logs/server.ADM', 1024)).rejects.toMatchObject({
      name: 'NitradoReadError',
      status: null,
      endpoint: '/logs/server.ADM',
      message: 'signed timeout',
    });
    await jest.runAllTimersAsync();
    await expectation;
    expect(getMock).toHaveBeenCalledTimes(3);
  });
});
