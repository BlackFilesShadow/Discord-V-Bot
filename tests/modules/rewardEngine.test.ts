/**
 * RewardEngine-Regressions fuer Link-Cutoff, Idempotenz und dauerhafte
 * Batch-Verarbeitung. Insbesondere darf kein 500er-Fenster neue Kills verhungern.
 */
import { decidePvpReward, runPvpRewardShadow, type PvpAdmEvent, type RewardEngineClient } from '../../src/modules/nitrado/adm/rewardEngine';

const RULE = { rewardRuleId: 'pvp:default', baseAmount: 100n };
const EVENT_AT = new Date('2026-08-16T12:00:00.000Z');
const CREATED_AT = new Date('2026-08-16T12:00:01.000Z');

function event(overrides: Partial<PvpAdmEvent> = {}): PvpAdmEvent {
  return {
    id: overrides.id ?? 'e1',
    actorGameId: overrides.actorGameId ?? 'victim',
    targetGameId: Object.prototype.hasOwnProperty.call(overrides, 'targetGameId') ? (overrides.targetGameId ?? null) : 'killer',
    occurredAt: Object.prototype.hasOwnProperty.call(overrides, 'occurredAt') ? (overrides.occurredAt ?? null) : EVENT_AT,
    createdAt: overrides.createdAt ?? CREATED_AT,
  };
}

describe('decidePvpReward', () => {
  it('SKIPPED_INVALID_IDENTITY ohne Killer-ID', () => {
    const d = decidePvpReward(event({ targetGameId: null }), null, RULE);
    expect(d.status).toBe('SKIPPED');
    expect(d.reasonCode).toBe('SKIPPED_INVALID_IDENTITY');
  });

  it('SKIPPED_ANTI_FARM bei Killer==Opfer', () => {
    const d = decidePvpReward(event({ actorGameId: 'x', targetGameId: 'x' }), 'u1', RULE);
    expect(d.reasonCode).toBe('SKIPPED_ANTI_FARM');
  });

  it('SKIPPED_REWARD_DISABLED bei Betrag 0', () => {
    const d = decidePvpReward(event(), 'user-123', { rewardRuleId: 'pvp:default', baseAmount: 0n });
    expect(d.status).toBe('SKIPPED');
    expect(d.reasonCode).toBe('SKIPPED_REWARD_DISABLED');
    expect(d.calculated.toString()).toBe('0');
  });

  it('SKIPPED wenn Killer unverlinkt oder Ereignis vor dem Link liegt', () => {
    const d = decidePvpReward(event(), null, RULE);
    expect(d.status).toBe('SKIPPED');
    expect(d.reasonCode).toBe('SKIPPED_UNLINKED_OR_PRELINK_KILLER');
  });

  it('PENDING bei zum Eventzeitpunkt verlinktem Killer', () => {
    const d = decidePvpReward(event(), 'user-123', RULE);
    expect(d.status).toBe('PENDING');
    expect(d.userDiscordId).toBe('user-123');
    expect(d.calculated.toString()).toBe('100');
  });
});

describe('runPvpRewardShadow — durable batches', () => {
  function makeClient(events: PvpAdmEvent[]) {
    const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
    const decisionKeys = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    const cursors = new Map<string, { lastTimestamp: Date; lastEntityId: string }>();
    let failOnId: string | null = null;

    const client: RewardEngineClient = {
      admEvent: {
        findMany: async (args: unknown) => {
          const a = args as { where: { OR?: Array<Record<string, unknown>> }; take?: number };
          const first = a.where.OR?.[0] as { createdAt?: { gt?: Date } } | undefined;
          const second = a.where.OR?.[1] as { createdAt?: Date; id?: { gt?: string } } | undefined;
          const ts = first?.createdAt?.gt ?? new Date(0);
          const id = second?.id?.gt ?? '';
          return sorted
            .filter(row => row.createdAt > ts || (row.createdAt.getTime() === ts.getTime() && row.id > id))
            .slice(0, a.take ?? 500)
            .map(row => ({ ...row }));
        },
      },
      rewardDecision: {
        findMany: async (args: unknown) => {
          const where = (args as { where: { admEventId: { in: string[] }; rewardRuleId: string } }).where;
          return where.admEventId.in
            .filter(id => decisionKeys.has(`${id}\u0000${where.rewardRuleId}`))
            .map(admEventId => ({ admEventId }));
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          if (data.admEventId === failOnId) throw new Error('simulated storage failure');
          const key = `${data.admEventId}\u0000${data.rewardRuleId}`;
          if (decisionKeys.has(key)) {
            const err = new Error('Unique constraint failed') as Error & { code?: string };
            err.code = 'P2002';
            throw err;
          }
          decisionKeys.add(key);
          rows.push(data);
          return {};
        },
      },
      rewardProcessingCursor: {
        upsert: async (args: unknown) => {
          const w = (args as { where: { guildId_nitradoConnId_stream: { guildId: string; nitradoConnId: string; stream: string } } }).where.guildId_nitradoConnId_stream;
          const key = `${w.guildId}:${w.nitradoConnId}:${w.stream}`;
          if (!cursors.has(key)) cursors.set(key, { lastTimestamp: new Date(0), lastEntityId: '' });
          return { ...cursors.get(key)! };
        },
        updateMany: async (args: unknown) => {
          const a = args as { where: { guildId: string; nitradoConnId: string; stream: string }; data: { lastTimestamp: Date; lastEntityId: string } };
          const key = `${a.where.guildId}:${a.where.nitradoConnId}:${a.where.stream}`;
          const current = cursors.get(key) ?? { lastTimestamp: new Date(0), lastEntityId: '' };
          const next = { lastTimestamp: a.data.lastTimestamp, lastEntityId: a.data.lastEntityId };
          const ahead = next.lastTimestamp > current.lastTimestamp
            || (next.lastTimestamp.getTime() === current.lastTimestamp.getTime() && next.lastEntityId > current.lastEntityId);
          if (ahead) cursors.set(key, next);
          return { count: ahead ? 1 : 0 };
        },
      },
    };
    return { client, rows, cursors, decisionKeys, setFailOnId: (id: string | null) => { failOnId = id; } };
  }

  const scope = { guildId: 'g1', nitradoConnId: 'c1' };
  const linkAt = new Date('2026-08-16T12:00:00.000Z');
  const resolve = async (_gameId: string, occurredAt: Date | null): Promise<string | null> =>
    occurredAt && occurredAt >= linkAt ? 'user-1' : null;

  it('belohnt nur Ereignisse nach dem Link und entscheidet jeden Event nur einmal', async () => {
    const { client, rows } = makeClient([
      event({ id: 'before', occurredAt: new Date('2026-08-16T11:59:59.000Z'), createdAt: new Date('2026-08-16T12:00:01.000Z') }),
      event({ id: 'after', occurredAt: new Date('2026-08-16T12:00:01.000Z'), createdAt: new Date('2026-08-16T12:00:02.000Z') }),
      event({ id: 'unknown-time', occurredAt: null, createdAt: new Date('2026-08-16T12:00:03.000Z') }),
    ]);
    const first = await runPvpRewardShadow(client, scope, RULE, resolve);
    expect(first).toEqual({ decided: 3, wouldPay: 1, skipped: 2 });
    expect(rows.find(row => row.admEventId === 'before')).toMatchObject({ status: 'SKIPPED' });
    expect(rows.find(row => row.admEventId === 'after')).toMatchObject({ status: 'PENDING', userDiscordId: 'user-1' });
    const second = await runPvpRewardShadow(client, scope, RULE, resolve);
    expect(second).toEqual({ decided: 0, wouldPay: 0, skipped: 0 });
  });

  it('arbeitet Backlogs deutlich groesser als 500 ohne Starvation ab', async () => {
    const events = Array.from({ length: 1_205 }, (_, index) => event({
      id: `event-${String(index).padStart(5, '0')}`,
      occurredAt: new Date(EVENT_AT.getTime() + index * 1_000),
      createdAt: new Date(CREATED_AT.getTime() + index * 1_000),
    }));
    const { client, rows } = makeClient(events);
    const result = await runPvpRewardShadow(client, scope, RULE, async () => 'user-1', 200, 20);
    expect(result).toEqual({ decided: 1_205, wouldPay: 1_205, skipped: 0 });
    expect(rows).toHaveLength(1_205);
    expect(rows.some(row => row.admEventId === 'event-01204')).toBe(true);
  });

  it('wiederholt nach einem Speicherfehler dieselbe Seite sicher statt den Cursor zu ueberspringen', async () => {
    const events = Array.from({ length: 5 }, (_, index) => event({
      id: `event-${index}`,
      createdAt: new Date(CREATED_AT.getTime() + index * 1_000),
    }));
    const state = makeClient(events);
    state.setFailOnId('event-2');
    await expect(runPvpRewardShadow(state.client, scope, RULE, async () => 'u', 5, 2)).rejects.toThrow('simulated storage failure');

    state.setFailOnId(null);
    const retry = await runPvpRewardShadow(state.client, scope, RULE, async () => 'u', 5, 2);
    expect(retry.decided).toBe(3);
    expect(state.decisionKeys.size).toBe(5);
  });

  it('konsumiert deaktivierte Kills als SKIPPED ohne Identitaetsaufloesung', async () => {
    const { client, rows } = makeClient([event({ id: 'disabled' })]);
    const resolver = jest.fn(async () => 'user-1');
    const result = await runPvpRewardShadow(client, scope, { rewardRuleId: 'pvp:default', baseAmount: 0n }, resolver);
    expect(result).toEqual({ decided: 1, wouldPay: 0, skipped: 1 });
    expect(resolver).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ status: 'SKIPPED', reasonCode: 'SKIPPED_REWARD_DISABLED' });
  });
});
