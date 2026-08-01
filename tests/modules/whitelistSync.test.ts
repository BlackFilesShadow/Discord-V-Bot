/**
 * Phase 7 WL-V2: Whitelist-Diff. Case-insensitiv; toAdd/toRemove/synced korrekt.
 */
import { diffWhitelist, resolveEntryState } from '../../src/modules/whitelist/whitelistSync';

describe('diffWhitelist', () => {
  it('trennt lokal-only, remote-only, synced (case-insensitiv)', () => {
    const d = diffWhitelist(['Alice', 'Bob', 'carol'], ['bob', 'CAROL', 'Dave']);
    expect(d.toAdd).toEqual(['Alice']);
    expect(d.toRemove).toEqual(['Dave']);
    expect(d.synced.sort()).toEqual(['Bob', 'carol']);
  });

  it('leere Listen', () => {
    expect(diffWhitelist([], [])).toEqual({ toAdd: [], toRemove: [], synced: [] });
  });

  it('ignoriert leere/whitespace Namen', () => {
    const d = diffWhitelist(['  ', 'Alice'], ['']);
    expect(d.toAdd).toEqual(['Alice']);
    expect(d.toRemove).toEqual([]);
  });

  it('alle lokal -> alle toAdd', () => {
    const d = diffWhitelist(['a', 'b'], []);
    expect(d.toAdd.sort()).toEqual(['a', 'b']);
  });
});

describe('resolveEntryState', () => {
  it('remote vorhanden -> SYNCED, sonst LOCAL_ONLY', () => {
    expect(resolveEntryState(true)).toBe('SYNCED');
    expect(resolveEntryState(false)).toBe('LOCAL_ONLY');
  });
});
