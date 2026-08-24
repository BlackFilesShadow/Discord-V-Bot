import {
  categoryAllowed,
  categoryForEvent,
  deriveGameplayFeedView,
  kindForEvent,
} from '../../src/modules/gameplayFeeds/types';

const base = {
  id: 'event-1',
  occurredAt: new Date('2026-08-15T00:00:00Z'),
  createdAt: new Date('2026-08-15T00:00:01Z'),
  actorGameId: 'victim-id',
  actorName: 'Victim',
  targetGameId: 'killer-id',
  targetName: 'Killer',
  objectType: null,
  toolOrWeapon: 'Mosin 91/30',
  distanceMeters: 123.4,
  actorPosition: '1,2,3',
  targetPosition: '4,5,6',
};

describe('Gameplay feed category semantics', () => {
  it('trennt PvP vom generischen PLAYER_DIED-Rohereignis', () => {
    expect(categoryForEvent('PLAYER_KILLED')).toBe('PVP');
    expect(kindForEvent('PLAYER_KILLED')).toBe('DEATH');

    // PLAYER_DIED bleibt als ADM-Rohereignis erhalten, ist aber bewusst kein
    // zustellbarer Gameplay-Feed mehr. Dadurch wird kein unzuverlaessiger
    // generischer Todesgrund als eigener Discord-Report dargestellt.
    expect(categoryForEvent('PLAYER_DIED')).toBeNull();
    expect(kindForEvent('PLAYER_DIED')).toBeNull();
    expect(deriveGameplayFeedView(
      { ...base, eventType: 'PLAYER_DIED' },
      { showActorCoords: true, showTargetCoords: true, showTool: true, showDistance: true },
    )).toBeNull();
  });

  it('ordnet alle Bauaktionen dem Baufeed zu', () => {
    expect(categoryForEvent('PLACEMENT')).toBe('PLACEMENT');
    expect(categoryForEvent('BUILD')).toBe('BUILD');
    expect(categoryForEvent('DISMANTLE')).toBe('DISMANTLE');
    expect(categoryForEvent('DESTROY')).toBe('DESTROY');
    expect(kindForEvent('DESTROY')).toBe('BUILD');
  });

  it('respektiert konfigurierte Kategorien strikt', () => {
    expect(categoryAllowed('DEATH', ['PVP'], 'PLAYER_KILLED')).toBe(true);
    expect(categoryAllowed('DEATH', ['PVP'], 'PLAYER_DIED')).toBe(false);
    expect(categoryAllowed('BUILD', ['BUILD'], 'BUILD')).toBe(true);
    expect(categoryAllowed('BUILD', ['BUILD'], 'DESTROY')).toBe(false);
  });

  it('wendet Anzeige-Toggles ohne Datenumdeutung an', () => {
    const view = deriveGameplayFeedView(
      { ...base, eventType: 'PLAYER_KILLED' },
      { showActorCoords: true, showTargetCoords: false, showTool: true, showDistance: false },
    );
    expect(view).toMatchObject({
      kind: 'DEATH',
      category: 'PVP',
      actorName: 'Victim',
      targetName: 'Killer',
      toolOrWeapon: 'Mosin 91/30',
      distanceMeters: null,
      actorPosition: '1,2,3',
      targetPosition: null,
    });
  });

  it('liefert fuer unbekannte ADM-Ereignisse keinen Feed-View', () => {
    expect(deriveGameplayFeedView(
      { ...base, eventType: 'PLAYER_HIT' },
      { showActorCoords: true, showTargetCoords: true, showTool: true, showDistance: true },
    )).toBeNull();
  });
});
