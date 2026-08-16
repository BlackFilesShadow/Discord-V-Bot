/**
 * RewardEngine-Regression: gleiche Kill-Zeile erzeugt nie zwei Auszahlungen und
 * ein Ereignis vor der Account-Verknuepfung wird dauerhaft uebersprungen.
 */
import { decidePvpReward, runPvpRewardShadow, type RewardEngineClient } from '../../src/modules/nitrado/adm/rewardEngine';

const RULE = { rewardRuleId: 'pvp:default', baseAmount: 100n };
const EVENT_AT = new Date('2026-08-16T12:00:00.000Z');

describe('decidePvpReward', () => {
  it('SKIPPED_INVALID_IDENTITY ohne Killer-ID', () => {
    const d = decidePvpReward({ id: 'e1', actorGameId: 'victim', targetGameId: null, occurredAt: EVENT_AT }, null, RULE);
    expect(d.status).toBe('SKIPPED');
    expect(d.reasonCode).toBe('SKIPPED_INVALID_IDENTITY');
  });
  it('SKIPPED_ANTI_FARM bei Killer==Opfer', () => {
    const d = decidePvpReward({ id: 'e1', actorGameId: 'x', targetGameId: 'x', occurredAt: EVENT_AT }, 'u1', RULE);
    expect(d.reasonCode).toBe('SKIPPED_ANTI_FARM');
  });
  it('SKIPPED wenn Killer unverlinkt oder Ereignis vor dem Link liegt', () => {
    const d = decidePvpReward({ id: 'e1', actorGameId: 'v', targetGameId: 'k', occurredAt: EVENT_AT }, null, RULE);
    expect(d.status).toBe('SKIPPED');
    expect(d.reasonCode).toBe('SKIPPED_UNLINKED_OR_PRELINK_KILLER');
  });
  it('PENDING (WOULD_PAY) bei zum Eventzeitpunkt verlinktem Killer', () => {
    const d = decidePvpReward({ id: 'e1', actorGameId: 'v', targetGameId: 'k', occurredAt: EVENT_AT }, 'user-123', RULE);
    expect(d.status).toBe('PENDING');
    expect(d.userDiscordId).toBe('user-123');
    expect(d.calculated).toBe(100n);
    expect(d.reasonCode).toBe('WOULD_PAY_SHADOW');
  });
});

describe('runPvpRewardShadow — Idempotenz + Linkzeitpunkt', () => {
  function makeClient(events: Array<{ id: string; actorGameId: string | null; targetGameId: string | null; occurredAt: Date | null }>) {
    const decided = new Set<string>();
    const rows: Array<Record<string, unknown>> = [];
    const client: RewardEngineClient = {
      admEvent: { findMany: async () => events },
      rewardDecision: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const key = `${data.admEventId}\u0000${data.rewardRuleId}`;
          if (decided.has(key)) {
            const err = new Error('Unique constraint failed') as Error & { code?: string };
            err.code = 'P2002';
            throw err;
          }
          decided.add(key);
          rows.push(data);
          return {};
        },
      },
    };
    return { client, rows };
  }

  const scope = { guildId: 'g1', nitradoConnId: 'c1' };
  const linkAt = new Date('2026-08-16T12:00:00.000Z');
  const events = [
    { id: 'before', actorGameId: 'victim1', targetGameId: 'killer', occurredAt: new Date('2026-08-16T11:59:59.000Z') },
    { id: 'after', actorGameId: 'victim2', targetGameId: 'killer', occurredAt: new Date('2026-08-16T12:00:01.000Z') },
    { id: 'unknown-time', actorGameId: 'victim3', targetGameId: 'killer', occurredAt: null },
  ];
  const resolve = async (_gameId: string, occurredAt: Date | null): Promise<string | null> =>
    occurredAt && occurredAt >= linkAt ? 'user-1' : null;

  it('belohnt nur Ereignisse nach dem Link und entscheidet jeden Event nur einmal', async () => {
    const { client, rows } = makeClient(events);
    const first = await runPvpRewardShadow(client, scope, RULE, resolve);
    expect(first).toEqual({ decided: 3, wouldPay: 1, skipped: 2 });
    expect(rows.find(row => row.admEventId === 'before')).toMatchObject({
      status: 'SKIPPED',
      userDiscordId: null,
      reasonCode: 'SKIPPED_UNLINKED_OR_PRELINK_KILLER',
    });
    expect(rows.find(row => row.admEventId === 'after')).toMatchObject({
      status: 'PENDING',
      userDiscordId: 'user-1',
    });

    const second = await runPvpRewardShadow(client, scope, RULE, resolve);
    expect(second.decided).toBe(0);
  });
});
