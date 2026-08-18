/**
 * Phase 7 KEEP: Keep-Online-Statusmaschine. Kernregel: nie aus suspended
 * starten; gestoppt/offline duerfen bei aktiviertem Keep-Online starten.
 */
import { decideKeepOnlineAction, reconcileKeepOnline } from '../../src/modules/nitrado/keepOnline';

describe('decideKeepOnlineAction', () => {
  it('startet einen gestoppten Server, wenn aktiviert', () => {
    expect(decideKeepOnlineAction({ enabled: true, state: 'stopped' })).toBe('START');
  });
  it('startet einen tatsaechlich offline Server, wenn aktiviert', () => {
    expect(decideKeepOnlineAction({ enabled: true, state: 'offline' })).toBe('START');
  });
  it('startet NICHT aus suspended (Kernregel)', () => {
    expect(decideKeepOnlineAction({ enabled: true, state: 'suspended' })).toBe('NONE');
  });
  it('macht nichts, wenn deaktiviert', () => {
    expect(decideKeepOnlineAction({ enabled: false, state: 'stopped' })).toBe('NONE');
    expect(decideKeepOnlineAction({ enabled: false, state: 'offline' })).toBe('NONE');
  });
  it('macht nichts bei started/restarting/unknown', () => {
    expect(decideKeepOnlineAction({ enabled: true, state: 'started' })).toBe('NONE');
    expect(decideKeepOnlineAction({ enabled: true, state: 'restarting' })).toBe('NONE');
    expect(decideKeepOnlineAction({ enabled: true, state: 'unknown' })).toBe('NONE');
  });
});

describe('reconcileKeepOnline', () => {
  it('liefert nur die zu startenden Slots', () => {
    const out = reconcileKeepOnline([
      { nitradoConnId: 'a', enabled: true, state: 'stopped' },
      { nitradoConnId: 'b', enabled: true, state: 'suspended' },
      { nitradoConnId: 'c', enabled: false, state: 'stopped' },
      { nitradoConnId: 'd', enabled: true, state: 'started' },
      { nitradoConnId: 'e', enabled: true, state: 'offline' },
    ]);
    expect(out).toEqual(['a', 'e']);
  });
});
