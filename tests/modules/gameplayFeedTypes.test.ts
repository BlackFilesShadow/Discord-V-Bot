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
  it('trennt PvP-Killfeed strikt vom Deathfeed', () => {
    expect(categoryForEvent('PLAYER_KILLED')).toBe('PVP');
    expect(kindForEvent('PLAYER_KILLED')).toBe('KILL');
    expect(categoryAllowed('KILL', ['PVP'], 'PLAYER_KILLED')).toBe(true);
    expect(categoryAllowed('DEATH', ['OTHER'], 'PLAYER_KILLED')).toBe(false);
  });

  it('macht generische PLAYER_DIED-Ereignisse als OTHER-Deathfeed darstellbar', () => {
    expect(categoryForEvent('PLAYER_DIED')).toBe('OTHER');
    expect(kindForEvent('PLAYER_DIED')).toBe('DEATH');
    const view = deriveGameplayFeedView(
      { ...base, eventType: 'PLAYER_DIED', targetName: 'Bled out', targetGameId: null },
      { showActorCoords: true, showTargetCoords: true, showTool: true, showDistance: true },
    );
    expect(view).toMatchObject({ kind: 'DEATH', category: 'OTHER', actorName: 'Victim', targetName: 'Bled out' });
  });

  it('ordnet spezifische Nicht-PvP-Tode ausschliesslich DEATH zu', () => {
    expect(kindForEvent('PLAYER_SUICIDE')).toBe('DEATH');
    expect(kindForEvent('NPC_KILL')).toBe('DEATH');
    expect(kindForEvent('VEHICLE_DEATH')).toBe('DEATH');
    expect(categoryAllowed('KILL', ['PVP'], 'PLAYER_SUICIDE')).toBe(false);
    expect(categoryAllowed('DEATH', ['SUICIDE', 'NPC', 'VEHICLE', 'OTHER'], 'PLAYER_SUICIDE')).toBe(true);
  });

  it('ordnet alle Bauaktionen dem Baufeed bzw. Placement zu', () => {
    expect(categoryForEvent('PLACEMENT')).toBe('PLACEMENT');
    expect(categoryForEvent('BUILD')).toBe('BUILD');
    expect(categoryForEvent('DISMANTLE')).toBe('DISMANTLE');
    expect(categoryForEvent('DESTROY')).toBe('DESTROY');
    expect(kindForEvent('DESTROY')).toBe('BUILD');
    expect(kindForEvent('PLACEMENT')).toBe('PLACEMENT');
  });

  it('respektiert konfigurierte Kategorien strikt', () => {
    expect(categoryAllowed('KILL', ['PVP'], 'PLAYER_KILLED')).toBe(true);
    expect(categoryAllowed('DEATH', ['OTHER'], 'PLAYER_DIED')).toBe(true);
    expect(categoryAllowed('DEATH', ['SUICIDE'], 'PLAYER_DIED')).toBe(false);
    expect(categoryAllowed('BUILD', ['BUILD'], 'BUILD')).toBe(true);
    expect(categoryAllowed('BUILD', ['BUILD'], 'DESTROY')).toBe(false);
  });

  it('wendet Anzeige-Toggles ohne Datenumdeutung an', () => {
    const view = deriveGameplayFeedView(
      { ...base, eventType: 'PLAYER_KILLED' },
      { showActorCoords: true, showTargetCoords: false, showTool: true, showDistance: false },
    );
    expect(view).toMatchObject({
      kind: 'KILL',
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
