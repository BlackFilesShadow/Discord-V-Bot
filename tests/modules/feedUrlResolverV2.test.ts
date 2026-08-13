import { extractYouTubeRef, resolveFeedSource } from '../../src/modules/feeds/urlResolver';

describe('feed source validation', () => {
  test('rejects individual YouTube video URLs', () => {
    expect(extractYouTubeRef('https://www.youtube.com/watch?v=abcdefghijk')).toBeNull();
    expect(resolveFeedSource('YOUTUBE', 'https://youtu.be/abcdefghijk').ok).toBe(false);
  });

  test('canonicalizes YouTube handles and playlists', () => {
    expect(resolveFeedSource('YOUTUBE', 'https://youtube.com/@OpenAI')).toMatchObject({ ok: true, resolved: { url: '@OpenAI' } });
    expect(resolveFeedSource('YOUTUBE', 'https://youtube.com/playlist?list=PL123_test')).toMatchObject({ ok: true, resolved: { url: 'playlist:PL123_test' } });
  });

  test('accepts YouTube user URLs', () => {
    expect(resolveFeedSource('YOUTUBE', 'https://www.youtube.com/user/example')).toMatchObject({ ok: true, resolved: { url: 'user:example' } });
  });

  test('rejects private RSS hosts', () => {
    expect(resolveFeedSource('RSS', 'http://127.0.0.1/feed.xml').ok).toBe(false);
    expect(resolveFeedSource('NEWS', 'http://192.168.1.2/news').ok).toBe(false);
  });
});
