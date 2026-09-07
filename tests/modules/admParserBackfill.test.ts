import { ADM_PARSER_VERSION } from '../../src/modules/nitrado/adm/admLineParser';
import {
  buildHistoricalReparsePatch,
  runAdmParserBackfill,
  type AdmParserBackfillClient,
} from '../../src/modules/nitrado/adm/admParserBackfill';

interface TestRow {
  id: string;
  eventKey: string;
  sourceFile: string;
  sourceByteStart: bigint;
  occurredAt: Date | null;
  createdAt: Date;
  rawLine: string;
  parserVersion: number;
}

function makeClient(rows: TestRow[], state: { completedAt: Date | null; lastCheckedAt: Date | null } = {
  completedAt: null,
  lastCheckedAt: null,
}) {
  const findMany = jest.fn()
    .mockResolvedValueOnce(rows)
    .mockResolvedValue([]);
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const flagCreateMany = jest.fn().mockResolvedValue({ count: 1 });
  const stateUpsert = jest.fn().mockResolvedValue(state);
  const stateUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const tx = {
    admEvent: { updateMany },
    flagActivityEvent: { createMany: flagCreateMany },
  };
  const transaction = jest.fn(async (fn: (value: typeof tx) => Promise<unknown>) => fn(tx));

  const client = {
    admEvent: { findMany, updateMany },
    flagActivityEvent: { createMany: flagCreateMany },
    admParserBackfillState: { upsert: stateUpsert, updateMany: stateUpdateMany },
    $transaction: transaction,
  } as unknown as AdmParserBackfillClient;

  return {
    client,
    findMany,
    updateMany,
    flagCreateMany,
    stateUpsert,
    stateUpdateMany,
    transaction,
  };
}

const scope = { guildId: 'guild-1', nitradoConnId: 'conn-1' };
const occurredAt = new Date('2026-09-01T10:15:30.000Z');
const createdAt = new Date('2026-09-01T10:15:31.000Z');

describe('ADM parser history backfill', () => {
  test('reclassifies a historical packed shelter as DISMANTLE with the current parser', () => {
    const patch = buildHistoricalReparsePatch(
      'Player "Builder" (id=guid-1 pos=<100, 20, 300>) packed Improvised Shelter with Hands',
      occurredAt,
    );

    expect(patch).toMatchObject({
      admEventType: 'DISMANTLE',
      flagAction: null,
      parsed: {
        eventType: 'DISMANTLE',
        objectType: 'Improvised Shelter',
        toolOrWeapon: 'Hands',
        occurredAt,
      },
    });
  });

  test('reparses old rows in place and never rewinds a source cursor', async () => {
    const row: TestRow = {
      id: 'old-event-1',
      eventKey: 'a'.repeat(64),
      sourceFile: 'binding:1:server.ADM',
      sourceByteStart: 120n,
      occurredAt,
      createdAt,
      rawLine: 'Player "Builder" (id=guid-1 pos=<100, 20, 300>) packed Tarp Shelter with Hands',
      parserVersion: ADM_PARSER_VERSION - 1,
    };
    const mocks = makeClient([row]);

    const result = await runAdmParserBackfill(mocks.client, scope, {
      batchSize: 50,
      maxBatches: 2,
      now: new Date('2026-09-07T20:50:00.000Z'),
    });

    expect(result).toMatchObject({ reparsed: 1, flagRowsCreated: 0, complete: true });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: row.id,
        guildId: scope.guildId,
        nitradoConnId: scope.nitradoConnId,
        parserVersion: { lt: ADM_PARSER_VERSION },
      }),
      data: expect.objectContaining({
        eventType: 'DISMANTLE',
        objectType: 'Tarp Shelter',
        toolOrWeapon: 'Hands',
        parserVersion: ADM_PARSER_VERSION,
      }),
    }));

    // Der Client-Vertrag besitzt absichtlich keinen admSourceCursor-Port. Ein
    // Reparse kann den Remote-Byte-Cursor deshalb konstruktiv nicht anfassen.
    expect('admSourceCursor' in (mocks.client as unknown as Record<string, unknown>)).toBe(false);
  });

  test('backfills a missing dynamic flag row with its historical createdAt', async () => {
    const row: TestRow = {
      id: 'old-flag-1',
      eventKey: 'b'.repeat(64),
      sourceFile: 'binding:1:server.ADM',
      sourceByteStart: 240n,
      occurredAt,
      createdAt,
      rawLine: 'Player "Builder" (id=guid-1 pos=<100, 20, 300>) has lowered Flag_Base on StaticFlagPole at <101, 21, 301>',
      parserVersion: ADM_PARSER_VERSION - 1,
    };
    const mocks = makeClient([row]);

    const result = await runAdmParserBackfill(mocks.client, scope, {
      batchSize: 50,
      maxBatches: 2,
      now: new Date('2026-09-07T20:50:00.000Z'),
    });

    expect(result).toMatchObject({ reparsed: 1, flagRowsCreated: 1, complete: true });
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        eventType: 'UNKNOWN',
        targetName: 'StaticFlagPole',
        parserVersion: ADM_PARSER_VERSION,
      }),
    }));
    expect(mocks.flagCreateMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        eventKey: row.eventKey,
        action: 'LOWERED',
        totemType: 'StaticFlagPole',
        createdAt,
      })],
      skipDuplicates: true,
    });
  });

  test('keeps explosive non-player kill causes out of Wild/NPC during historical reparse', () => {
    const patch = buildHistoricalReparsePatch(
      'Player "Victim" (DEAD) (id=victim-guid pos=<100, 20, 300>) killed by M67Grenade',
      occurredAt,
    );

    expect(patch.parsed).toMatchObject({
      eventType: 'PLAYER_DIED',
      targetName: 'M67Grenade',
    });
    expect(patch.admEventType).toBe('PLAYER_DIED');
  });

  test('does not rescan a recently completed parser version', async () => {
    const completedAt = new Date('2026-09-07T18:00:00.000Z');
    const mocks = makeClient([], { completedAt, lastCheckedAt: completedAt });

    const result = await runAdmParserBackfill(mocks.client, scope, {
      now: new Date('2026-09-07T20:00:00.000Z'),
    });

    expect(result).toEqual({
      reparsed: 0,
      flagRowsCreated: 0,
      complete: true,
      deferredCompletedRecheck: true,
    });
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
