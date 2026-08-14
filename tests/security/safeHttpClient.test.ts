/**
 * F-003 Regression: SSRF-gehaerteter HTTP-Client.
 *  - safeLookup gibt nur oeffentliche IPs frei (DNS-Rebinding-Schutz).
 *  - safeAxiosGet blockiert private Hosts und ungueltige Protokolle, bevor
 *    ueberhaupt eine Verbindung aufgebaut wird.
 */

const lookupMock = jest.fn();
jest.mock('node:dns', () => ({
  __esModule: true,
  default: { lookup: (...args: unknown[]) => lookupMock(...args) },
}));

import { safeLookup, safeAxiosGet, isBlockedHost } from '../../src/utils/ssrf';

type Cb = (err: NodeJS.ErrnoException | null, address: string | { address: string; family: number }[], family?: number) => void;

beforeEach(() => { jest.clearAllMocks(); });

describe('F-003 — safeLookup (DNS-Rebinding)', () => {
  it('gibt eine oeffentliche IP frei', (done) => {
    lookupMock.mockImplementation((_h: string, _o: unknown, cb: Cb) => cb(null, [{ address: '93.184.216.34', family: 4 }]));
    safeLookup('example.com', { all: true }, (err, addr) => {
      expect(err).toBeNull();
      expect(addr).toEqual([{ address: '93.184.216.34', family: 4 }]);
      done();
    });
  });

  it('blockiert eine private IP (DNS-Rebinding)', (done) => {
    lookupMock.mockImplementation((_h: string, _o: unknown, cb: Cb) => cb(null, [{ address: '10.0.0.5', family: 4 }]));
    safeLookup('rebind.evil', { all: true }, (err) => {
      expect(err).toBeInstanceOf(Error);
      done();
    });
  });

  it('blockiert die Cloud-Metadata-IP', (done) => {
    lookupMock.mockImplementation((_h: string, _o: unknown, cb: Cb) => cb(null, [{ address: '169.254.169.254', family: 4 }]));
    safeLookup('metadata.evil', { all: true }, (err) => {
      expect(err).toBeInstanceOf(Error);
      done();
    });
  });

  it('blockiert IPv6 Link-Local auch ausserhalb des fe80::/16-Präfixes', (done) => {
    lookupMock.mockImplementation((_h: string, _o: unknown, cb: Cb) => cb(null, [{ address: 'febf::1', family: 6 }]));
    safeLookup('ipv6-link-local.evil', { all: true }, (err) => {
      expect(err).toBeInstanceOf(Error);
      done();
    });
  });

  it('filtert gemischte Ergebnisse auf die oeffentlichen IPs', (done) => {
    lookupMock.mockImplementation((_h: string, _o: unknown, cb: Cb) => cb(null, [
      { address: '10.0.0.5', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ]));
    safeLookup('mixed.example', { all: true }, (err, addr) => {
      expect(err).toBeNull();
      expect(addr).toEqual([{ address: '93.184.216.34', family: 4 }]);
      done();
    });
  });
});

describe('F-003 — safeAxiosGet (Vorab-Validierung)', () => {
  it('blockiert Loopback-Hosts ohne Verbindungsaufbau', async () => {
    await expect(safeAxiosGet('http://127.0.0.1/x')).rejects.toThrow(/SSRF/);
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it('blockiert localhost', async () => {
    await expect(safeAxiosGet('http://localhost:8080/')).rejects.toThrow(/SSRF/);
  });

  it('lehnt nicht-http(s)-Protokolle ab', async () => {
    await expect(safeAxiosGet('ftp://example.com/x')).rejects.toThrow(/SSRF/);
  });

  it('isBlockedHost erkennt Metadata- und Private-Ranges weiterhin', () => {
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('10.1.2.3')).toBe(true);
    expect(isBlockedHost('93.184.216.34')).toBe(false);
  });

  it('blockiert den gesamten IPv6 Link-Local-Bereich fe80::/10', () => {
    expect(isBlockedHost('fe80::1')).toBe(true);
    expect(isBlockedHost('fe9a::1')).toBe(true);
    expect(isBlockedHost('fea0::1')).toBe(true);
    expect(isBlockedHost('febf::1')).toBe(true);
  });

  it('blockiert ULA, Multicast und IPv4-mapped Loopback auch in Hex-Schreibweise', () => {
    expect(isBlockedHost('fc00::1')).toBe(true);
    expect(isBlockedHost('fd12:3456::1')).toBe(true);
    expect(isBlockedHost('ff02::1')).toBe(true);
    expect(isBlockedHost('::ffff:7f00:1')).toBe(true);
    expect(isBlockedHost('::ffff:10.0.0.1')).toBe(true);
  });

  it('laesst globale IPv6-Adressen weiterhin zu', () => {
    expect(isBlockedHost('2606:4700:4700::1111')).toBe(false);
  });
});
