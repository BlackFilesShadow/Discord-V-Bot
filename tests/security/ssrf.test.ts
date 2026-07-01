import { isBlockedHost, validatePublicHttpUrl } from '../../src/utils/ssrf';

describe('SSRF-Schutz (isBlockedHost)', () => {
  describe('blockierte Hosts', () => {
    const blocked = [
      'localhost',
      'sub.localhost',
      '0.0.0.0',
      '127.0.0.1',
      '127.1.2.3',
      '10.0.0.5',
      '10.255.255.255',
      '192.168.1.1',
      '172.16.0.1',
      '172.20.10.1',
      '172.31.255.255',
      '169.254.169.254', // AWS/Cloud-Metadata
      '100.64.0.1', // CGNAT
      '100.127.255.255',
      '::1',
      '::',
      'fe80::1',
      'fc00::1',
      'fd12:3456::1',
      '::ffff:127.0.0.1', // IPv4-mapped Loopback
      '::ffff:10.0.0.1',
    ];
    it.each(blocked)('blockiert %s', (host) => {
      expect(isBlockedHost(host)).toBe(true);
    });

    it('blockiert IPv6-Literale in Klammern', () => {
      expect(isBlockedHost('[::1]')).toBe(true);
      expect(isBlockedHost('[fe80::1]')).toBe(true);
    });

    it('blockiert leeren Host', () => {
      expect(isBlockedHost('')).toBe(true);
      expect(isBlockedHost('   ')).toBe(true);
    });
  });

  describe('erlaubte oeffentliche Hosts', () => {
    const allowed = [
      'example.com',
      'api.github.com',
      'fcbarcelona.com', // darf NICHT faelschlich als ULA (fc..) blockiert werden
      'fe80n.example.com',
      '8.8.8.8',
      '1.1.1.1',
      '172.15.0.1', // knapp ausserhalb 172.16/12
      '172.32.0.1',
      '192.169.0.1',
      '100.63.0.1', // knapp ausserhalb CGNAT
      '100.128.0.1',
      '2001:4860:4860::8888', // oeffentliches IPv6 (Google DNS)
    ];
    it.each(allowed)('erlaubt %s', (host) => {
      expect(isBlockedHost(host)).toBe(false);
    });
  });
});

describe('validatePublicHttpUrl', () => {
  it('akzeptiert oeffentliche https-URL', () => {
    const r = validatePublicHttpUrl('https://example.com/feed.xml');
    expect(r.ok).toBe(true);
  });

  it('lehnt private Hosts ab', () => {
    expect(validatePublicHttpUrl('http://127.0.0.1/x').ok).toBe(false);
    expect(validatePublicHttpUrl('http://169.254.169.254/latest/meta-data').ok).toBe(false);
    expect(validatePublicHttpUrl('http://[::1]/x').ok).toBe(false);
  });

  it('lehnt nicht-http(s)-Protokolle ab', () => {
    expect(validatePublicHttpUrl('javascript:alert(1)').ok).toBe(false);
    expect(validatePublicHttpUrl('file:///etc/passwd').ok).toBe(false);
    expect(validatePublicHttpUrl('ftp://example.com/x').ok).toBe(false);
  });

  it('lehnt ungueltige URLs ab', () => {
    expect(validatePublicHttpUrl('nicht-eine-url').ok).toBe(false);
  });
});
