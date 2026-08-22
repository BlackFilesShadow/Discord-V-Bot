import express from 'express';
import request from 'supertest';
import { createMutationOriginGuard } from '../../src/dashboard/middleware/mutationOrigin';

function appFor(allowedUrl = 'https://dashboard.example.test') {
  const app = express();
  app.use(createMutationOriginGuard(allowedUrl));
  app.all('*', (req, res) => res.json({ ok: true, path: req.path }));
  return app;
}

describe('Stage 41 cookie mutation Origin gate', () => {
  it('allows safe reads independent of browser Origin metadata', async () => {
    const res = await request(appFor())
      .get('/api/v2/guilds/123')
      .set('Origin', 'https://attacker.example');
    expect(res.status).toBe(200);
  });

  it('allows an exact dashboard Origin and same-origin Referer', async () => {
    const byOrigin = await request(appFor())
      .post('/api/v2/action')
      .set('Origin', 'https://dashboard.example.test');
    expect(byOrigin.status).toBe(200);

    const byReferer = await request(appFor())
      .patch('/auth/2fa/verify')
      .set('Referer', 'https://dashboard.example.test/settings/security');
    expect(byReferer.status).toBe(200);
  });

  it.each([
    ['foreign Origin', { Origin: 'https://attacker.example' }],
    ['opaque Origin', { Origin: 'null' }],
    ['foreign Referer', { Referer: 'https://attacker.example/form' }],
    ['cross-site Fetch Metadata', { 'Sec-Fetch-Site': 'cross-site' }],
  ])('rejects %s before a cookie-authenticated mutation', async (_label, headers) => {
    const res = await request(appFor())
      .delete('/api/v2/guilds/123/resource')
      .set(headers);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_ORIGIN_DENIED');
  });

  it('allows headerless non-browser clients to continue into normal AuthN/AuthZ gates', async () => {
    const res = await request(appFor()).post('/api/v2/action');
    expect(res.status).toBe(200);
  });

  it('keeps HMAC-authenticated webhooks outside the cookie Origin boundary', async () => {
    const res = await request(appFor())
      .post('/webhooks/discord')
      .set('Origin', 'https://external-sender.example');
    expect(res.status).toBe(200);
  });

  it('fails closed when the configured dashboard URL is invalid', async () => {
    const res = await request(appFor('not a URL'))
      .post('/api/v2/action')
      .set('Origin', 'https://dashboard.example.test');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_ORIGIN_DENIED');
  });
});
