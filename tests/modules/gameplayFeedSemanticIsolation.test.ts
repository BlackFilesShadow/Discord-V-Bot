import fs from 'node:fs';
import path from 'node:path';
import {
  BUILD_CATEGORIES,
  DEATH_CATEGORIES,
  KILL_CATEGORIES,
  PLACEMENT_CATEGORIES,
  categoryAllowed,
  deriveGameplayFeedView,
  kindForEvent,
} from '../../src/modules/gameplayFeeds/types';

describe('gameplay feed semantic isolation', () => {
  it('keeps KILL and DEATH mutually exclusive', () => {
    expect(KILL_CATEGORIES).toEqual(['PVP']);
    expect(DEATH_CATEGORIES).toEqual(['SUICIDE', 'NPC', 'VEHICLE', 'OTHER']);
    expect(kindForEvent('PLAYER_KILLED')).toBe('KILL');
    expect(kindForEvent('PLAYER_SUICIDE')).toBe('DEATH');
    expect(kindForEvent('PLAYER_DIED')).toBe('DEATH');
    expect(categoryAllowed('KILL', KILL_CATEGORIES, 'PLAYER_KILLED')).toBe(true);
    expect(categoryAllowed('KILL', KILL_CATEGORIES, 'PLAYER_DIED')).toBe(false);
    expect(categoryAllowed('DEATH', DEATH_CATEGORIES, 'PLAYER_KILLED')).toBe(false);
    expect(categoryAllowed('DEATH', DEATH_CATEGORIES, 'PLAYER_DIED')).toBe(true);
  });

  it('keeps BUILD and PLACEMENT as mutually exclusive semantic kinds', () => {
    expect(BUILD_CATEGORIES).toEqual(['BUILD', 'DISMANTLE', 'DESTROY']);
    expect(PLACEMENT_CATEGORIES).toEqual(['PLACEMENT']);
    expect(kindForEvent('PLACEMENT')).toBe('PLACEMENT');
    expect(kindForEvent('BUILD')).toBe('BUILD');

    expect(categoryAllowed('BUILD', BUILD_CATEGORIES, 'PLACEMENT')).toBe(false);
    expect(categoryAllowed('BUILD', ['PLACEMENT'], 'PLACEMENT')).toBe(false);
    expect(categoryAllowed('PLACEMENT', PLACEMENT_CATEGORIES, 'BUILD')).toBe(false);
    expect(categoryAllowed('PLACEMENT', PLACEMENT_CATEGORIES, 'PLACEMENT')).toBe(true);
  });

  it('derives a PvP event as KILL/PVP and never as DEATH', () => {
    const view = deriveGameplayFeedView({
      id: 'event-kill',
      eventType: 'PLAYER_KILLED',
      occurredAt: new Date('2026-09-09T12:00:00.000Z'),
      createdAt: new Date('2026-09-09T12:00:01.000Z'),
      actorGameId: 'victim',
      actorName: 'Victim',
      targetGameId: 'killer',
      targetName: 'Killer',
      objectType: null,
      toolOrWeapon: 'M4-A1',
      distanceMeters: 42,
      actorPosition: '100, 200, 10',
      targetPosition: '110, 210, 10',
    }, {
      showActorCoords: true,
      showTargetCoords: true,
      showTool: true,
      showDistance: true,
    });
    expect(view?.kind).toBe('KILL');
    expect(view?.category).toBe('PVP');
  });

  it('derives a generic death as DEATH/OTHER', () => {
    const view = deriveGameplayFeedView({
      id: 'event-death',
      eventType: 'PLAYER_DIED',
      occurredAt: new Date('2026-09-09T12:00:00.000Z'),
      createdAt: new Date('2026-09-09T12:00:01.000Z'),
      actorGameId: 'victim',
      actorName: 'Victim',
      targetGameId: null,
      targetName: 'Bled out',
      objectType: null,
      toolOrWeapon: null,
      distanceMeters: null,
      actorPosition: '100, 200, 10',
      targetPosition: null,
    }, {
      showActorCoords: true,
      showTargetCoords: false,
      showTool: false,
      showDistance: false,
    });
    expect(view?.kind).toBe('DEATH');
    expect(view?.category).toBe('OTHER');
  });

  it('derives a PLACEMENT event as PLACEMENT and never as BUILD', () => {
    const view = deriveGameplayFeedView({
      id: 'event-placement',
      eventType: 'PLACEMENT',
      occurredAt: new Date('2026-08-30T12:00:00.000Z'),
      createdAt: new Date('2026-08-30T12:00:01.000Z'),
      actorGameId: 'game-1',
      actorName: 'Builder',
      targetGameId: null,
      targetName: null,
      objectType: 'GardenPlot',
      toolOrWeapon: null,
      distanceMeters: null,
      actorPosition: '100, 200, 10',
      targetPosition: null,
    }, {
      showActorCoords: true,
      showTargetCoords: false,
      showTool: true,
      showDistance: false,
    });

    expect(view?.kind).toBe('PLACEMENT');
    expect(view?.category).toBe('PLACEMENT');
  });

  it('dashboard contract exposes KILL and DEATH as separate clickable functions', () => {
    const ui = fs.readFileSync(path.resolve('dashboard-ui/src/components/KillfeedTab.tsx'), 'utf8');
    expect(ui).toContain("type FeedKind = 'KILL' | 'DEATH' | 'BUILD' | 'PLACEMENT' | 'PLAYER_LIST' | 'FLAG'");
    expect(ui).toContain("KILL: ['PVP']");
    expect(ui).toContain("DEATH: ['SUICIDE', 'NPC', 'VEHICLE', 'OTHER']");
    expect(ui).toContain("setKind('KILL')");
    expect(ui).toContain('💀 Killfeed');
    expect(ui).toContain("setKind('DEATH')");
    expect(ui).toContain('☠️ Deathfeed');
    expect(ui).toContain("BUILD: ['BUILD', 'DISMANTLE', 'DESTROY']");
    expect(ui).toContain("PLACEMENT: ['PLACEMENT']");
  });

  it('API and socket contracts expose KILL and PLACEMENT as first-class feed kinds', () => {
    const route = fs.readFileSync(path.resolve('src/dashboard/routes/v2/killfeed.ts'), 'utf8');
    const emitter = fs.readFileSync(path.resolve('src/dashboard/socket/emitter.ts'), 'utf8');
    expect(route).toContain("value === 'KILL'");
    expect(route).toContain("if (kind === 'KILL') return KILL_CATEGORIES");
    expect(route).toContain('Ein Killfeed darf ausschliesslich die Kategorie PVP enthalten.');
    expect(route).toContain("value === 'PLACEMENT'");
    expect(route).toContain("if (kind === 'PLACEMENT') return PLACEMENT_CATEGORIES");
    expect(route).toContain('Ein Placement-Feed darf ausschliesslich die Kategorie PLACEMENT enthalten.');
    expect(emitter).toContain("kind?: 'KILL' | 'DEATH' | 'BUILD' | 'PLACEMENT' | 'PLAYER_LIST' | 'FLAG'");
  });

  it('migration splits mixed DEATH configs and transfers existing PvP deliveries', () => {
    const enumMigration = fs.readFileSync(
      path.resolve('prisma/migrations/20260909001000_gameplay_feed_kill_kind/migration.sql'),
      'utf8',
    );
    const splitMigration = fs.readFileSync(
      path.resolve('prisma/migrations/20260909001100_split_kill_death_configs/migration.sql'),
      'utf8',
    );

    expect(enumMigration).toContain("ADD VALUE IF NOT EXISTS 'KILL'");
    expect(splitMigration).toContain("'KILL'::\"GameplayFeedKind\"");
    expect(splitMigration).toContain("array_remove(c.\"categories\", 'PVP')");
    expect(splitMigration).toContain('UPDATE "GameplayFeedDelivery" d');
    expect(splitMigration).toContain("a.\"eventType\" = 'PLAYER_KILLED'");
    expect(splitMigration).toContain("SET \"kind\" = 'KILL'::\"GameplayFeedKind\"");
    expect(splitMigration).toContain("array_append(\"categories\", 'OTHER')");
  });

  it('retains the existing placement split migration gate', () => {
    const enumMigration = fs.readFileSync(
      path.resolve('prisma/migrations/20260830184000_gameplay_feed_placement_kind/migration.sql'),
      'utf8',
    );
    const splitMigration = fs.readFileSync(
      path.resolve('prisma/migrations/20260830184100_split_placement_build_configs/migration.sql'),
      'utf8',
    );
    expect(enumMigration).toContain("ADD VALUE IF NOT EXISTS 'PLACEMENT'");
    expect(splitMigration).toContain("'PLACEMENT'::\"GameplayFeedKind\"");
    expect(splitMigration).toContain('UPDATE "GameplayFeedDelivery" d');
  });
});
