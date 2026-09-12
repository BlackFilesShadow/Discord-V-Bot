import {
  claimWhitelistRequest,
  type WhitelistRequestClaimClient,
} from '../../src/modules/whitelist/whitelistRequestClaim';

function client(overrides: {
  pending?: { createdAt: Date } | null;
  activeCount?: number;
} = {}) {
  const query = jest.fn().mockResolvedValue([]);
  const findFirst = jest.fn().mockResolvedValue(overrides.pending ?? null);
  const count = jest.fn().mockResolvedValue(overrides.activeCount ?? 0);
  const create = jest.fn().mockResolvedValue({ id: 'request-1' });
  const tx = { $queryRawUnsafe: query, whitelistRequest: { findFirst, count, create } };
  const db: WhitelistRequestClaimClient = {
    $transaction: async <T>(work: (inner: typeof tx) => Promise<T>) => work(tx),
  };
  return { db, query, findFirst, count, create };
}

const INPUT = {
  scope: { guildId: '111111111111111111', nitradoConnId: 'conn-a' },
  gameId: 'Void_Architect',
  channelId: '222222222222222222',
  requesterDiscordId: '333333333333333333',
  maxActivePerUser: 8,
};

describe('whitelist request claim', () => {
  it('nimmt vor Pending-Recheck und Create einen transaction-scoped Advisory-Lock', async () => {
    const ctx = client();
    await expect(claimWhitelistRequest(ctx.db, INPUT)).resolves.toEqual({
      kind: 'CREATED',
      request: { id: 'request-1' },
    });

    expect(ctx.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
      'whitelist-request:111111111111111111:conn-a:void_architect',
    );
    expect(ctx.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        guildId: INPUT.scope.guildId,
        nitradoConnId: INPUT.scope.nitradoConnId,
        gameId: { equals: INPUT.gameId, mode: 'insensitive' },
        status: 'PENDING',
      }),
    }));
    expect(ctx.create).toHaveBeenCalledTimes(1);
  });

  it('liefert einen vorhandenen Pending-Antrag und mutiert nicht', async () => {
    const createdAt = new Date('2026-09-12T00:00:00.000Z');
    const ctx = client({ pending: { createdAt } });
    await expect(claimWhitelistRequest(ctx.db, INPUT)).resolves.toEqual({
      kind: 'ALREADY_PENDING',
      createdAt,
    });
    expect(ctx.count).not.toHaveBeenCalled();
    expect(ctx.create).not.toHaveBeenCalled();
  });

  it('revalidiert das aktive User-Limit unter demselben Lock', async () => {
    const ctx = client({ activeCount: 8 });
    await expect(claimWhitelistRequest(ctx.db, INPUT)).resolves.toEqual({
      kind: 'LIMIT_REACHED',
      activeCount: 8,
    });
    expect(ctx.create).not.toHaveBeenCalled();
  });
});
