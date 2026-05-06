/**
 * Tests fuer das Cooldown-System (utils/cooldown.ts).
 *
 * Validiert Schlaf-Verhalten ohne echte Wartezeit (wir manipulieren Date.now
 * via jest fake-timers — der Modul-Code liest now() ueber Date.now() direkt).
 */

import {
  checkCooldown,
  clearCooldown,
  getCooldownStats,
} from '../../src/utils/cooldown';

describe('checkCooldown', () => {
  beforeEach(() => {
    // Frische Identitaet pro Test, damit Cross-Test-State nicht beisst.
    clearCooldown('alice', 'help');
    clearCooldown('alice', 'ai');
    clearCooldown('bob', 'help');
  });

  it('liefert ok=true wenn cooldown=0/undefined ist (kein Cooldown gesetzt)', () => {
    expect(checkCooldown('alice', 'help', 0).ok).toBe(true);
    expect(checkCooldown('alice', 'help', undefined).ok).toBe(true);
  });

  it('erster Aufruf darf, zweiter wird geblockt mit verbleibenden Sekunden', () => {
    const first = checkCooldown('alice', 'help', 5);
    expect(first.ok).toBe(true);
    const second = checkCooldown('alice', 'help', 5);
    expect(second.ok).toBe(false);
    expect(second.remainingSec).toBeGreaterThan(0);
    expect(second.remainingSec).toBeLessThanOrEqual(5);
  });

  it('isoliert User pro (User x Command)', () => {
    expect(checkCooldown('alice', 'help', 5).ok).toBe(true);
    expect(checkCooldown('bob', 'help', 5).ok).toBe(true); // anderer User -> ok
    expect(checkCooldown('alice', 'ai', 5).ok).toBe(true); // anderer Command -> ok
    expect(checkCooldown('alice', 'help', 5).ok).toBe(false); // selber User+Command -> blockt
  });

  it('clearCooldown gibt User wieder frei', () => {
    expect(checkCooldown('alice', 'help', 30).ok).toBe(true);
    expect(checkCooldown('alice', 'help', 30).ok).toBe(false);
    clearCooldown('alice', 'help');
    expect(checkCooldown('alice', 'help', 30).ok).toBe(true);
  });

  it('getCooldownStats meldet >=1 nach Set', () => {
    checkCooldown('alice', 'help', 60);
    expect(getCooldownStats().entries).toBeGreaterThanOrEqual(1);
  });

  it('lauft nach Ablauf der Sekundenfrist wieder ok', () => {
    jest.useFakeTimers();
    try {
      const t0 = 1_700_000_000_000;
      jest.setSystemTime(t0);
      expect(checkCooldown('alice', 'help', 2).ok).toBe(true);
      expect(checkCooldown('alice', 'help', 2).ok).toBe(false);
      jest.setSystemTime(t0 + 2_500); // 2.5s spaeter
      expect(checkCooldown('alice', 'help', 2).ok).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});
