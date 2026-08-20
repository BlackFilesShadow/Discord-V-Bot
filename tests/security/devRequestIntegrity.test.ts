import type { Request } from 'express';
import { config } from '../../src/config';
import {
  devMutationOriginVerdict,
  isDevMutationRequest,
} from '../../src/dashboard/middleware/devRequestIntegrity';

function req(options: {
  method?: string;
  url?: string;
  origin?: string;
  secFetchSite?: string;
} = {}): Pick<Request, 'method' | 'originalUrl' | 'get'> {
  const headers = new Map<string, string>();
  if (options.origin !== undefined) headers.set('origin', options.origin);
  if (options.secFetchSite !== undefined) headers.set('sec-fetch-site', options.secFetchSite);
  return {
    method: options.method ?? 'POST',
    originalUrl: options.url ?? '/api/v2/dev/login',
    get: ((name: string) => headers.get(name.toLowerCase())) as Request['get'],
  };
}

describe('Dashboard-2A DEV request integrity', () => {
  const dashboardOrigin = new URL(config.dashboard.url).origin;

  test('classifies only unsafe /api/v2/dev requests as DEV mutations', () => {
    expect(isDevMutationRequest(req())).toBe(true);
    expect(isDevMutationRequest(req({ method: 'DELETE', url: '/api/v2/dev/sessions/abc' }))).toBe(true);
    expect(isDevMutationRequest(req({ method: 'GET' }))).toBe(false);
    expect(isDevMutationRequest(req({ method: 'HEAD' }))).toBe(false);
    expect(isDevMutationRequest(req({ url: '/api/v2/bot-admin/dev-like' }))).toBe(false);
  });

  test('accepts a canonical same-origin DEV mutation', () => {
    expect(devMutationOriginVerdict(req({ origin: dashboardOrigin, secFetchSite: 'same-origin' }))).toEqual({ ok: true });
  });

  test('rejects explicit cross-site fetch metadata even with a forged matching Origin', () => {
    expect(devMutationOriginVerdict(req({ origin: dashboardOrigin, secFetchSite: 'cross-site' }))).toEqual({
      ok: false,
      reason: 'cross_site',
    });
  });

  test('rejects missing, malformed and foreign origins fail-closed', () => {
    expect(devMutationOriginVerdict(req())).toEqual({ ok: false, reason: 'origin_missing' });
    expect(devMutationOriginVerdict(req({ origin: 'not a url' }))).toEqual({ ok: false, reason: 'origin_invalid' });
    expect(devMutationOriginVerdict(req({ origin: 'https://evil.example' }))).toEqual({ ok: false, reason: 'origin_mismatch' });
  });

  test('does not impose the DEV contract on unrelated mutations or safe reads', () => {
    expect(devMutationOriginVerdict(req({ url: '/api/v2/guilds/123/economy' }))).toEqual({ ok: true });
    expect(devMutationOriginVerdict(req({ method: 'GET', url: '/api/v2/dev/status' }))).toEqual({ ok: true });
  });
});
