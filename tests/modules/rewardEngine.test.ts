/**
 * Phase 3, Schritt 4: Shadow-RewardEngine. Kernbeweis: dieselbe Kill-Zeile
 * erzeugt NIE zwei Auszahlungen (Unique admEventId+rewardRuleId).
 */
import { decidePvpReward, runPvpRewardShadow, type RewardEngineClient } from '../../src/modules/nitrado/adm/rewardEngine';

const RULE = { rewardRuleId: 'pvp:default', baseAmount: 100n };

describe('decidePvpReward', () => {
  it('SKIPPED_INVALID_IDENTITY ohne Killer-ID', () => {
    const d = decidePvpReward({ id: 'e1', actorGameId: 'victim', targetGameId: null }, null, RULE);
    expect(d.status).toBe('SKIPPED');
    expect(d.reasonCode).toBe('SKIPPED_INVALID_IDENTITY');
  });
  it('SKIPPED_ANTI_FARM bei Killer==Opfer', () => {
    const d = decidePvpReward({ id: 'e1', actorGameId: 'x', targetGameId: 'x' }, 'u1', RULE);
    expect(d.reasonCode).toBe('SKIPPED_ANTI_FARM');
  });
  it('SKIPPED_UNLINKED_KILLER wenn Killer nicht verlinkt', () => {
    const d = decidePvpReward({ id: 'e1', actorGameId: 'v', targetGameId: 'k' }, null, RULE);
    expect(d.status).toBe('SKIPPED');
    expect(d.reasonCode).toBe('SKIPPED_UNLINKED_KILLER');
  });
  it('PENDING (WOULD_PAY) bei verlinktem Killer', () => {
    const d = decidePvpReward({ id: 'e1', actorGameId: 'v', targetGameId: 'k' }, 'user-123', RULE);
    expect(d.status).toBe('PENDING');
    expect(d.userDiscordId).toBe('user-123');
    expect(d.calculated).toBe(100n);
    expect(d.reasonCode).toBe('WOULD_PAY_SHADOW');
  });
});

describe('runPvpRewardShadow — Idempotenz', () => {
  function makeClient(events: Array<{ id: string; actorGameId: string | null; targetGameId: string | null }>, links: Record<string, string>) {
    const decided = new Set<string>();
    const client: RewardEngineClient = {
      admEvent: { findMany: async () => events },
      economyLink: {
        findUnique: async (args: unknown) => {
          const gameId = (args as { where: { guildId_nitradoConnId_gameId: { gameId: string } } }).where.guildId_nitradoConnId_gameId.gameId;
          return links[gameId] ? { userDiscordId: links[gameId] } : null;
        },
      },
      rewardDecision: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const key = `${data.admEventId}\u0000${data.rewardRuleId}`;
          if (decided.has(key)) {
            const err = new Error('Unique constraint failed') as Error & { code?: string };
            err.code = 'P2002';
            throw err;
          }
          decided.add(key);
          return {};
        },
      },
    };
    return client;
  }

  const scope = { guildId: 'g1', nitradoConnId: 'c1' };
  const events = [
    { id: 'e1', actorGameId: 'victim1', targetGameId: 'killer-linked' },
    { id: 'e2', actorGameId: 'victim2', targetGameId: 'killer-unlinked' },
  ];
  const links = { 'killer-linked': 'user-1' };

  it('erster Lauf entscheidet alle, zweiter Lauf 0 (idempotent)', async () => {
    const client = makeClient(events, links);
    const first = await runPvpRewardShadow(client, scope, RULE);
    expect(first.decided).toBe(2);
    expect(first.wouldPay).toBe(1);
    expect(first.skipped).toBe(1);

    const second = await runPvpRewardShadow(client, scope, RULE);
    expect(second.decided).toBe(0); // alle bereits entschieden -> keine Doppelauszahlung
  });
});
