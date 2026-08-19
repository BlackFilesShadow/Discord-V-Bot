import {
  SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS,
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
  const identityUpsert = jest.fn(async (_args: unknown) => ({}));
  const findMany = jest.fn(async (args: unknown) => {
    const where = (args as { where?: { status?: unknown } })?.where;
    const payloads = where?.status === 'DEAD' ? recentDeadPayloads : activePayloads;
    return payloads.map(payload => ({ payload }));
  });
  const queryRaw = jest.fn(async (_query: string, ..._values: unknown[]) => []);
  const client = {
    $queryRawUnsafe: queryRaw,
    nitradoJob: { findMany, create },
    serverBanRemoteIdentity: { upsert: identityUpsert },
  } as unknown as BanOutboxClient;
  return { client, findMany, create, queryRaw, identityUpsert };
}

describe('Server-Ban Outbox', () => {
  it('speichert ADD-Identifier nur verschluesselt und nimmt Connection- vor Subject-Lock', async () => {
    const { client, create, queryRaw, identityUpsert } = makeClient();
    const raw = '76561198000000000';

    await expect(enqueueServerBanAdd(client, SCOPE, 'ban-1', raw, KEY)).resolves.toBe(true);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    for (const call of queryRaw.mock.calls) {
      expect(call[0]).toBe('SELECT pg_advisory_xact_lock($1, $2)');
      expect(call[1]).toEqual(expect.any(Number));
      expect(call[2]).toEqual(expect.any(Number));
    }
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(queryRaw.mock.invocationCallOrder[1]);
    expect(queryRaw.mock.invocationCallOrder[1]).toBeLessThan(identityUpsert.mock.invocationCallOrder[0]);
    expect(identityUpsert.mock.invocationCallOrder[0]).toBeLessThan(create.mock.invocationCallOrder[0]);

    const args = create.mock.calls[0][0] as { data: { operation: string; payload: unknown } };
    expect(args.data.operation).toBe('SERVER_BAN_ADD');
    const payload = parseServerBanJobPayload(args.data.payload);
    expect(payload.banId).toBe('ban-1');
    expect(payload.encryptedIdentifier).toBeDefined();
    expect(payload.encryptedIdentifier).not.toContain(raw);
    expect(decrypt(payload.encryptedIdentifier!, KEY)).toBe(raw);

    const persisted = identityUpsert.mock.calls[0][0] as {
      where: { banId: string };
      create: { banId: string; identifierEnc: string };
      update: { identifierEnc: string };
    };
    expect(persisted.where).toEqual({ banId: 'ban-1' });
    expect(persisted.create.banId).toBe('ban-1');
    expect(persisted.create.identifierEnc).toBe(payload.encryptedIdentifier);
    expect(persisted.update.identifierEnc).toBe(payload.encryptedIdentifier);
    expect(decrypt(persisted.create.identifierEnc, KEY)).toBe(raw);
  });

  it('aktualisiert die verschluesselte Reconciliation-Identitaet auch bei aktiv dedupliziertem ADD', async () => {
    const { client, create, identityUpsert } = makeClient([{ banId: 'ban-1' }]);

    await expect(enqueueServerBanAdd(client, SCOPE, 'ban-1', 'PlayerOne', KEY)).resolves.toBe(false);

    expect(identityUpsert).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
    const args = identityUpsert.mock.calls[0][0] as { create: { identifierEnc: string } };
    expect(decrypt(args.create.identifierEnc, KEY)).toBe('PlayerOne');
  });

  it('REMOVE persistiert nur die Ban-ID und keinen Reconciliation-Identifier', async () => {
    const { client, create, identityUpsert } = makeClient();

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(true);
    const args = create.mock.calls[0][0] as { data: { operation: string; payload: unknown } };
    expect(args.data.operation).toBe('SERVER_BAN_REMOVE');
    expect(args.data.payload).toEqual({ banId: 'ban-1' });
    expect(identityUpsert).not.toHaveBeenCalled();
  });

  it('dedupliziert aktive Jobs derselben Operation+Ban-ID unter beiden DB-Locks', async () => {
    const { client, create, findMany, queryRaw } = makeClient([{ banId: 'ban-1' }]);

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(false);

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('blockiert automatische ADD-Reparatur bei recent DEAD, behaelt aber den verschluesselten Repair-Identifier', async () => {
    const now = new Date('2026-08-19T03:00:00.000Z');
    const { client, create, findMany, identityUpsert } = makeClient([], [{}]);

    await expect(enqueueServerBanAdd(
      client,
      SCOPE,
      'ban-1',
      'PlayerOne',
      KEY,
      { recentDeadCooldownMs: SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS, now },
    )).resolves.toBe(false);

    expect(identityUpsert).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledTimes(2);
    const deadQuery = findMany.mock.calls[1][0] as {
      where: { operation: string; status: string; updatedAt: { gte: Date } };
    };
    expect(deadQuery.where.operation).toBe('SERVER_BAN_ADD');
    expect(deadQuery.where.status).toBe('DEAD');
    expect(deadQuery.where.updatedAt.gte).toEqual(
      new Date(now.getTime() - SERVER_BAN_ADD_AUTO_DEAD_COOLDOWN_MS),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('blockiert automatische REMOVE-Neuanlage bei einem recent DEAD derselben Connection', async () => {
    const now = new Date('2026-08-18T16:00:00.000Z');
    const { client, create, findMany, queryRaw } = makeClient([], [{}]);

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1', { now })).resolves.toBe(false);

    expect(queryRaw).toHaveBeenCalledTimes(2);
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
    const { client, create, findMany } = makeClient([], []);

    await expect(enqueueServerBanRemove(client, SCOPE, 'ban-1')).resolves.toBe(true);

    expect(findMany).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('laesst expliziten Bediener-Retry den REMOVE-DEAD-Cooldown umgehen, aber nicht aktive Dedupe-Jobs', async () => {
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

  it('teilt die Connection-Barriere, aber trennt Ban-Subjects nach Ban-ID', async () => {
    const a = makeClient();
    const b = makeClient();

    await enqueueServerBanRemove(a.client, SCOPE, 'ban-1');
    await enqueueServerBanRemove(b.client, SCOPE, 'ban-2');

    expect(a.queryRaw.mock.calls[0].slice(1)).toEqual(b.queryRaw.mock.calls[0].slice(1));
    expect(a.queryRaw.mock.calls[1].slice(1)).not.toEqual(b.queryRaw.mock.calls[1].slice(1));
  });

  it('lehnt ungueltige Payloads ab', () => {
    expect(() => parseServerBanJobPayload({})).toThrow('Ungueltige Server-Ban-Job-Payload');
  });
});
