import fs from 'node:fs';
import path from 'node:path';
import {
  BUILD_CATEGORIES,
  PLACEMENT_CATEGORIES,
  categoryAllowed,
  deriveGameplayFeedView,
  kindForEvent,
} from '../../src/modules/gameplayFeeds/types';

describe('#293 gameplay feed semantic isolation', () => {
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

  it('dashboard contract cannot offer PLACEMENT inside BUILD defaults', () => {
    const ui = fs.readFileSync(path.resolve('dashboard-ui/src/components/KillfeedTab.tsx'), 'utf8');
    expect(ui).toContain("type FeedKind = 'DEATH' | 'BUILD' | 'PLACEMENT' | 'PLAYER_LIST' | 'FLAG'");
    expect(ui).toContain("BUILD: ['BUILD', 'DISMANTLE', 'DESTROY']");
    expect(ui).toContain("PLACEMENT: ['PLACEMENT']");
    expect(ui).not.toContain("BUILD: ['PLACEMENT', 'BUILD', 'DISMANTLE', 'DESTROY']");
  });

  it('API contract exposes PLACEMENT and uses its dedicated category set', () => {
    const route = fs.readFileSync(path.resolve('src/dashboard/routes/v2/killfeed.ts'), 'utf8');
    expect(route).toContain("value === 'PLACEMENT'");
    expect(route).toContain("if (kind === 'PLACEMENT') return PLACEMENT_CATEGORIES");
    expect(route).toContain('Ein Placement-Feed darf ausschliesslich die Kategorie PLACEMENT enthalten.');
  });

  it('migration splits mixed configs and transfers existing placement deliveries', () => {
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
    expect(splitMigration).toContain('array_remove(c."categories", \'PLACEMENT\')');
    expect(splitMigration).toContain('UPDATE "GameplayFeedDelivery" d');
    expect(splitMigration).toContain("a.\"eventType\" = 'PLACEMENT'");
    expect(splitMigration).toContain('SET "kind" = \'PLACEMENT\'::"GameplayFeedKind"');
  });
});
