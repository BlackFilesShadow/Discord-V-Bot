import axios from 'axios';
import { NitradoApiError, NitradoClient } from '../../src/modules/nitrado/nitradoClient';

type RequestFn = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  opts?: unknown,
) => Promise<unknown>;

type SignedFetchFn = (
  meta: { url: string; token?: string },
  maxBytes: number,
  fullPath: string,
  range?: { offset: number; count: number },
) => Promise<string>;

function stubTransport(client: NitradoClient): {
  request: jest.MockedFunction<RequestFn>;
  fetchSignedText: jest.MockedFunction<SignedFetchFn>;
} {
  const request = jest.fn<ReturnType<RequestFn>, Parameters<RequestFn>>();
  const fetchSignedText = jest.fn<ReturnType<SignedFetchFn>, Parameters<SignedFetchFn>>();
  Object.assign(client, { request, fetchSignedText });
  return { request, fetchSignedText };
}

describe('Nitrado ranged file fallback', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('keeps file_server/seek as the unchanged primary path when it succeeds', async () => {
    const client = new NitradoClient('test-token');
    const { request, fetchSignedText } = stubTransport(client);
    const token = { url: 'https://signed.example/seek', token: 'seek-token' };
    request.mockResolvedValue({ data: { token } });
    fetchSignedText.mockResolvedValue('seek-chunk');

    await expect(client.downloadFileRange('12345', '/logs/server.ADM', 1024, 4096))
      .resolves.toBe('seek-chunk');

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      'GET',
      '/services/12345/gameservers/file_server/seek',
      { params: { file: '/logs/server.ADM', offset: 1024, length: 4096, mode: 'raw' } },
    );
    expect(fetchSignedText).toHaveBeenCalledWith(token, 8192, '/logs/server.ADM');
  });

  it('falls back only for Nitrados seek length-limit response and preserves offset/count', async () => {
    const client = new NitradoClient('test-token');
    const { request, fetchSignedText } = stubTransport(client);
    const seekPath = '/services/12345/gameservers/file_server/seek';
    const downloadPath = '/services/12345/gameservers/file_server/download';
    const token = { url: 'https://signed.example/download', token: 'download-token' };

    request.mockImplementation(async (_method, path) => {
      if (path === seekPath) {
        throw new NitradoApiError('Length limit exceeded. Use file download instead.', 400, seekPath);
      }
      if (path === downloadPath) return { data: { token } };
      throw new Error(`Unexpected request: ${path}`);
    });
    fetchSignedText.mockResolvedValue('fallback-chunk');

    await expect(client.downloadFileRange('12345', '/logs/server.ADM', 111516, 512 * 1024))
      .resolves.toBe('fallback-chunk');

    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      2,
      'GET',
      downloadPath,
      { params: { file: '/logs/server.ADM' } },
    );
    expect(fetchSignedText).toHaveBeenCalledWith(
      token,
      (512 * 1024) + 4096,
      '/logs/server.ADM',
      { offset: 111516, count: 512 * 1024 },
    );
  });

  it('does not mask unrelated seek failures', async () => {
    const client = new NitradoClient('test-token');
    const { request, fetchSignedText } = stubTransport(client);
    const seekPath = '/services/12345/gameservers/file_server/seek';
    const original = new NitradoApiError('Forbidden', 403, seekPath);
    request.mockRejectedValue(original);

    await expect(client.downloadFileRange('12345', '/logs/server.ADM', 0, 4096))
      .rejects.toBe(original);

    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchSignedText).not.toHaveBeenCalled();
  });

  it('does not trigger fallback for the same text from a different endpoint', async () => {
    const client = new NitradoClient('test-token');
    const { request, fetchSignedText } = stubTransport(client);
    const original = new NitradoApiError(
      'Length limit exceeded. Use file download instead.',
      400,
      '/services/12345/gameservers/file_server/download',
    );
    request.mockRejectedValue(original);

    await expect(client.downloadFileRange('12345', '/logs/server.ADM', 0, 4096))
      .rejects.toBe(original);

    expect(request).toHaveBeenCalledTimes(1);
    expect(fetchSignedText).not.toHaveBeenCalled();
  });

  it('passes token, offset and count to the signed download request', async () => {
    const client = new NitradoClient('test-token');
    const get = jest.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: 'partial-data',
      headers: {},
    } as never);
    const signedFetch = client as unknown as {
      fetchSignedText: SignedFetchFn;
    };

    await expect(signedFetch.fetchSignedText(
      { url: 'https://signed.example/download', token: 'download-token' },
      8192,
      '/logs/server.ADM',
      { offset: 2048, count: 4096 },
    )).resolves.toBe('partial-data');

    expect(get).toHaveBeenCalledWith(
      'https://signed.example/download',
      expect.objectContaining({
        responseType: 'text',
        params: { token: 'download-token', offset: 2048, count: 4096 },
        maxContentLength: 8192,
        maxBodyLength: 8192,
      }),
    );
  });
});
