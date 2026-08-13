import { entriesAfterMarker, parseFeedDocument } from '../../src/modules/feeds/feedDocument';

describe('feedDocument', () => {
  test('parses RSS with CDATA, relative links and image enclosures', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>Demo</title><item><guid>item-2</guid><title><![CDATA[Hello &amp; World]]></title><link>/post/2</link><description><![CDATA[<p>Body <b>text</b></p>]]></description><pubDate>Wed, 13 Aug 2026 12:00:00 GMT</pubDate><enclosure url="/img.jpg" type="image/jpeg" /></item></channel></rss>`;
    const doc = parseFeedDocument(xml, 'https://example.com/feed.xml', 'application/rss+xml');
    expect(doc.format).toBe('RSS');
    expect(doc.entries[0]).toMatchObject({ id: 'item-2', title: 'Hello & World', link: 'https://example.com/post/2', description: 'Body text', image: 'https://example.com/img.jpg' });
  });

  test('parses Atom alternate links', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><id>tag:1</id><title>Entry</title><link rel="alternate" type="text/html" href="https://example.org/a"/><summary>Text</summary><updated>2026-08-13T12:00:00Z</updated></entry></feed>`;
    const doc = parseFeedDocument(xml, 'https://example.org/atom.xml', 'application/atom+xml');
    expect(doc.format).toBe('ATOM');
    expect(doc.entries[0].link).toBe('https://example.org/a');
  });

  test('parses JSON Feed 1.x', () => {
    const json = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'JSON', items: [{ id: 'j2', url: 'https://example.net/j2', title: 'JSON item', content_html: '<p>Hello</p>', image: 'https://example.net/a.webp', date_published: '2026-08-13T10:00:00Z' }] });
    const doc = parseFeedDocument(json, 'https://example.net/feed.json', 'application/feed+json');
    expect(doc.format).toBe('JSON');
    expect(doc.entries[0]).toMatchObject({ id: 'j2', description: 'Hello', image: 'https://example.net/a.webp' });
  });

  test('returns new entries oldest-first after a marker', () => {
    const entries = [
      { id: '3', title: '3', link: '', description: '', publishedAt: null, image: null },
      { id: '2', title: '2', link: '', description: '', publishedAt: null, image: null },
      { id: '1', title: '1', link: '', description: '', publishedAt: null, image: null },
    ];
    const state = entriesAfterMarker(entries, '1', 'latest');
    expect(state.toPost.map((e) => e.id)).toEqual(['2', '3']);
    expect(state.latestId).toBe('3');
  });

  test('avoids backlog spam when old marker is no longer in the feed window', () => {
    const entries = [
      { id: '3', title: '3', link: '', description: '', publishedAt: null, image: null },
      { id: '2', title: '2', link: '', description: '', publishedAt: null, image: null },
    ];
    const state = entriesAfterMarker(entries, 'old', 'latest');
    expect(state.toPost.map((e) => e.id)).toEqual(['3']);
    expect(state.markerFound).toBe(false);
  });
});
