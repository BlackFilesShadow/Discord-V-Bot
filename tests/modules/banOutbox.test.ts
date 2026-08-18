import {
  SERVER_BAN_REMOVE_AUTO_DEAD_COOLDOWN_MS,
  enqueueServerBanAdd,
  enqueueServerBanRemove,
  parseServerBanJobPayload,
  type BanOutboxClient,
} from '../../src/modules/bans/banOutbox';
import { decrypt } from '../../src/utils/security';

const KEY = '0'.repeat(64);
const SCOPE = { guildId: 'guild-a', nitradoConnId: 'conn-a' };

function makeClient(activePayloads: unknown[] = [], recentDeadPayloads: unknown[] = []) {
  const create = jest.fn(async (_args: unknown) => ({}));
  const findMany = jest.fn(async (args: unknown) => {
    const where = (args as { where?: { status?: unknown } })?.where;
    const payloads = where?.status === 'DEAD' ? recentDeadPayloads : activePayloads;
    return payloads.map(payload => ({ payload }));
  });
  const queryRaw = jest.fn(async (_query: string, ..._values: unknown[]) => []);
  const client = {
    $queryRawUnsafe: queryRaw,
    nitradoJob: { findMany, create },
  } as BanOutboxClient;
  return { client, findMany, create, queryRaw };
}

describe('Server-Ban Outbox', () => {
  it('speichert ADD-Identifier nur verschluesselt und sperrt den Subject-Key vorher', async () => {
    const { client, create, queryRaw } = makeClient();
    const raw = '76561198000000000';

    await expect(enqueueServerBanAdd(client, SCOPE, 'ban-1', raw, KEY)).resolves.toBe(true);
    expect(queryRaw).toHaveBeenCalledWith(
      'SELECT pg_advisory_xact_lock($1, $2)',
      expect.any(Number),
      expect.any(Number),
    );
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);

    const args = create.mock.calls[0][0] as { data: { operation: string; payload: unknown } };
    expect(args.data.operation).toBe('SERVER_BAN_ADD');
    const payload = parseServerBanJobPayload(args.data.payload);
    expect(payload.banId).toBe('ban-1');
    expect(payload.encryptedIdentifier).toBeDefined();
    expect(payload.encryptedIdentifier).not.toContain(raw);
    expect(decrypt(payload.encryptedIdentifier!, KEY)).toBe(raw);
  });

  it('REMOVE persistiert nur die Ban-ID', async () => {
    const { client, create } = makeClient();

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(true);
    const args = create.mock.calls[0][0] as { data: { operation: string; payload: unknown } };
    expect(args.data.operation).toBe('SERVER_BAN_REMOVE');
    expect(args.data.payload).toEqual({ banId: 'ban-1' });
  });

  it('dedupliziert aktive Jobs derselben Operation+Ban-ID unter dem DB-Lock', async () => {
    const { client, create, findMany, queryRaw } = makeClient([{ banId: 'ban-1' }]);

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(false);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('blockiert automatische REMOVE-Neuanlage bei einem recent DEAD derselben Connection', async () => {
    const now = new Date('2026-08-18T16:00:00.000Z');
    const { client, create, findMany, queryRaw } = makeClient([], [{}]);

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1', { now })).resolves.toBe(false);

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(2);
    const deadQuery = findMany.mock.calls[1][0] as {
      where: { status: string; updatedAt: { gte: Date } };
      select: { payload: boolean };
      take: number;
    };
    expect(deadQuery.where.status).toBe('DEAD');
    expect(deadQuery.where.updatedAt.gte).toEqual(
      new Date(now.getTime() - SERVER_BAN_REMOVE_AUTO_DEAD_COOLDOWN_MS),
    );
    expect(deadQuery.select).toEqual({ payload: true });
    expect(deadQuery.take).toBe(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('blockiert auch einen anderen Ban durch einen recent DEAD-REMOVE derselben Connection', async () => {
    const { client, create } = makeClient([], [{ banId: 'anderer-ban' }]);

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(false);

    expect(create).not.toHaveBeenCalled();
  });

  it('erlaubt nach Ablauf des DEAD-Cooldowns wieder einen automatischen REMOVE', async () => {
    // Die DB-Query liefert nur DEAD-Jobs >= Cooldown-Grenze; ein aelterer DEAD
    // erscheint deshalb nicht in `recentDeadPayloads`.
    const { client, create, findMany } = makeClient([], []);

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(true);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('laesst expliziten Bediener-Retry den DEAD-Cooldown umgehen, aber nicht aktive Dedupe-Jobs', async () => {
    const manual = makeClient([], [{}]);
    await expect(enqueueServerBanRemove(
      manual.client,
      SCOPE,
      'ban-1',
      { bypassRecentDeadCooldown: true },
    )).resolves.toBe(true);
    expect(manual.findMany).toHaveBeenCalledTimes(1);
    expect(manual.create).toHaveBeenCalledTimes(1);

    const active = makeClient([{ banId: 'ban-1' }], [{}]);
    await expect(enqueueServerBanRemove(
      active.client,
      SCOPE,
      'ban-1',
      { bypassRecentDeadCooldown: true },
    )).resolves.toBe(false);
    expect(active.findMany).toHaveBeenCalledTimes(1);
    expect(active.create).not.toHaveBeenCalled();
  });

  it('verwendet fuer verschiedene Ban-IDs verschiedene Advisory-Lock-Keys', async () => {
    const a = makeClient();
    const b = makeClient();

    await enqueueServerBanRemove(a.client, SCOPE, 'ban-1');
    await enqueueServerBanRemove(b.client, SCOPE, 'ban-2');

    expect(a.queryRaw.mock.calls[0].slice(1)).not.toEqual(b.queryRaw.mock.calls[0].slice(1));
  });

  it('lehnt ungueltige Payloads ab', () => {
    expect(() => parseServerBanJobPayload({})).toThrow('Ungueltige Server-Ban-Job-Payload');
  });
});