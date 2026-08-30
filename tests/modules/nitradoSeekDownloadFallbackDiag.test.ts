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

it('diagnoses signed seek 404 fallback runtime values', async () => {
  const client = new NitradoClient('test-token');
  const request = jest.fn<ReturnType<RequestFn>, Parameters<RequestFn>>();
  const fetchSignedText = jest.fn<ReturnType<SignedFetchFn>, Parameters<SignedFetchFn>>();
  Object.assign(client, { request, fetchSignedText });

  const seekPath = '/services/12345/gameservers/file_server/seek';
  const downloadPath = '/services/12345/gameservers/file_server/download';
  const fullPath = '/games/example/noftp/dayzps/config/DayZServer_PS4.ADM';
  const seekToken = { url: 'https://signed.example/seek', token: 'seek-token' };
  const downloadToken = { url: 'https://signed.example/download', token: 'download-token' };
  const signed404 = new NitradoApiError('Download HTTP 404', 404, fullPath);

  request.mockImplementation(async (_method, path) => {
    if (path === seekPath) return { data: { token: seekToken } };
    if (path === downloadPath) return { data: { token: downloadToken } };
    throw new Error(`Unexpected request: ${path}`);
  });
  fetchSignedText
    .mockRejectedValueOnce(signed404)
    .mockResolvedValueOnce('fallback-chunk');

  const guard = client as unknown as {
    isSeekDownloadFallbackError(error: unknown, seekPath: string, fullPath: string): boolean;
  };

  let caught: unknown;
  try {
    await client.downloadFileRange('12345', fullPath, 111516, 512 * 1024);
  } catch (error) {
    caught = error;
  }

  const caughtApiError = caught instanceof NitradoApiError ? caught : null;
  throw new Error(JSON.stringify({
    sameError: caught === signed404,
    caughtName: caught instanceof Error ? caught.name : typeof caught,
    caughtMessage: caught instanceof Error ? caught.message : String(caught),
    caughtStatus: caughtApiError?.status ?? null,
    caughtEndpoint: caughtApiError?.endpoint ?? null,
    signed404Status: signed404.status,
    signed404Endpoint: signed404.endpoint,
    expectedFullPath: fullPath,
    guardOnOriginal: guard.isSeekDownloadFallbackError(signed404, seekPath, fullPath),
    requestPaths: request.mock.calls.map(call => call[1]),
    fetchSignedTextCalls: fetchSignedText.mock.calls.length,
  }));
});
