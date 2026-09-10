import { restrictOpenSessionQuery } from '../../src/modules/economy/playtimeLiveRosterGuard';

describe('playtime live roster guard', () => {
  it('beschraenkt nur OPEN-Sessions auf aktuell bestaetigte ADM-Spieler', () => {
    const result = restrictOpenSessionQuery(
      {
        where: {
          guildId: 'g',
          nitradoConnId: 'n',
          status: 'OPEN',
          connectedAt: { not: null },
        },
        orderBy: [{ createdAt: 'asc' }],
      },
      new Set(['live-a', 'live-b']),
    ) as { where: Record<string, unknown>; orderBy: unknown };

    expect(result.where).toMatchObject({
      guildId: 'g',
      nitradoConnId: 'n',
      status: 'OPEN',
      gameId: { in: ['live-a', 'live-b'] },
    });
    expect(result.orderBy).toEqual([{ createdAt: 'asc' }]);
  });

  it('laesst CLOSED-Session-Pagination unveraendert', () => {
    const original = {
      where: { guildId: 'g', nitradoConnId: 'n', status: 'CLOSED' },
      take: 500,
    };
    expect(restrictOpenSessionQuery(original, new Set())).toBe(original);
  });

  it('ist bei leerem Live-Roster fail-closed fuer OPEN-Rewards', () => {
    const result = restrictOpenSessionQuery(
      { where: { status: 'OPEN' } },
      new Set(),
    ) as { where: { gameId: { in: string[] } } };
    expect(result.where.gameId.in).toEqual([]);
  });
});
