import {
  enqueueWhitelistAdd,
  enqueueWhitelistRemove,
  type WhitelistOutboxClient,
} from '../../src/modules/whitelist/whitelistOutbox';

const SCOPE = { guildId: 'guild-a', nitradoConnId: 'conn-a' };

type ExistingJob = { operation: 'WHITELIST_ADD' | 'WHITELIST_REMOVE'; payload: unknown };

function makeClient(existingJobs: ExistingJob[] = []) {
  const create = jest.fn(async (_args: unknown) => ({}));
  const findMany = jest.fn(async (args: unknown) => {
    const operation = (args as { where?: { operation?: string } })?.where?.operation;
    return existingJobs
      .filter(job => !operation || job.operation === operation)
      .map(job => ({ payload: job.payload }));
  });
  const queryRaw = jest.fn(async (_query: string, ..._values: unknown[]) => []);
  const client = {
    $queryRawUnsafe: queryRaw,
    nitradoJob: { findMany, create },
  } as WhitelistOutboxClient;
  return { client, create, findMany, queryRaw };
}

describe('Nitrado-1A Whitelist-Outbox', () => {
  it('legt ADD unter einem DB-xact-lock an', async () => {
    const { client, create, queryRaw } = makeClient();

    await expect(enqueueWhitelistAdd(client, SCOPE, 'Player One')).resolves.toBe(true);

    expect(queryRaw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1, $2)',
      expect.any(Number),
      expect.any(Number),
    );
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);
    expect(create).toHaveBeenCalledWith({
      data: {
        guildId: 'guild-a',
        nitradoConnId: 'conn-a',
        operation: 'WHITELIST_ADD',
        payload: { gameId: 'Player One' },
      },
    });
  });

  it('dedupliziert Namen case-insensitiv und trim-bewusst innerhalb derselben Operation', async () => {
    const { client, create } = makeClient([
      { operation: 'WHITELIST_ADD', payload: { gameId: ' PLAYER ONE ' } },
    ]);

    await expect(enqueueWhitelistAdd(client, SCOPE, 'player one')).resolves.toBe(false);

    expect(create).not.toHaveBeenCalled();
  });

  it('trennt ADD und REMOVE als unterschiedliche Intents', async () => {
    const remove = makeClient([
      { operation: 'WHITELIST_ADD', payload: { gameId: 'Player One' } },
    ]);

    await expect(enqueueWhitelistRemove(remove.client, SCOPE, 'Player One')).resolves.toBe(true);
    expect(remove.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ operation: 'WHITELIST_REMOVE' }),
    }));
    expect(remove.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ operation: 'WHITELIST_REMOVE' }),
    }));
  });

  it('verwendet fuer andere Guild/Connection/Operation/Names getrennte Locks', async () => {
    const a = makeClient();
    const b = makeClient();
    const c = makeClient();

    await enqueueWhitelistAdd(a.client, SCOPE, 'Player One');
    await enqueueWhitelistAdd(b.client, { ...SCOPE, nitradoConnId: 'conn-b' }, 'Player One');
    await enqueueWhitelistRemove(c.client, SCOPE, 'Player One');

    expect(a.queryRaw.mock.calls[0].slice(1)).not.toEqual(b.queryRaw.mock.calls[0].slice(1));
    expect(a.queryRaw.mock.calls[0].slice(1)).not.toEqual(c.queryRaw.mock.calls[0].slice(1));
  });

  it('lehnt leere Identifier ab, bevor ein DB-Lock oder Job entsteht', async () => {
    const { client, create, queryRaw } = makeClient();

    await expect(enqueueWhitelistAdd(client, SCOPE, '   ')).rejects.toThrow(/leerer Gameserver-Identifier/);

    expect(queryRaw).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
});
