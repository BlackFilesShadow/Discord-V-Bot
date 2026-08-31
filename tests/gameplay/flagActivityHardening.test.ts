import { newDateContext, parseAdmLine } from '../../src/modules/nitrado/adm/admLineParser';
import { shouldRestartReusedAdmFile } from '../../src/modules/nitrado/adm/admLiveSyncCron';
import { computeEventKey, ingestFullFile, persistAdmEvents } from '../../src/modules/nitrado/adm/serverLogIngestor';

describe('ADM flag hardening', () => {
  test('does not classify chat/report text as a flag action', () => {
    const lines = [
      '12:00:00 | Chat("Alpha"(id=abc)): has raised Flag_Base on TerritoryFlag at <1, 2, 3>',
      '12:00:01 | Chat: has lowered Flag_Base on TerritoryFlag at <1, 2, 3>',
      '12:00:02 | Player "Alpha" (id=abc pos=<1, 2, 3>) reported: has raised Flag_Base on TerritoryFlag at <4, 5, 6>',
    ];
    for (const line of lines) {
      const event = parseAdmLine(line, newDateContext(new Date(Date.UTC(2026, 7, 29))));
      expect(event?.eventType).not.toBe('FLAG_RAISED');
      expect(event?.eventType).not.toBe('FLAG_LOWERED');
    }
  });

  test('rejects malformed actor or flag coordinates instead of fabricating a flag event', () => {
    const lines = [
      '12:01:00 | Player "Alpha" (id=abc pos=<invalid>) has raised Flag_Base on TerritoryFlag at <4, 5, 6>',
      '12:01:01 | Player "Alpha" (id=abc pos=<1, 2, 3>) has raised Flag_Base on TerritoryFlag at <invalid>',
      '12:01:02 | Player "Alpha" (id=abc pos=<1, 2>) has lowered Flag_Base on TerritoryFlag at <4, 5, 6>',
    ];
    for (const line of lines) {
      const event = parseAdmLine(line, newDateContext(new Date(Date.UTC(2026, 7, 29))));
      expect(event?.eventType).not.toBe('FLAG_RAISED');
      expect(event?.eventType).not.toBe('FLAG_LOWERED');
    }
  });

  test('keeps player and flag X/Y/Z coordinates separate for a real DayZ action', () => {
    const event = parseAdmLine(
      '15:47:12 | Player "JtReaper" (id=player-1 pos=<9713.25, 167.81, 13149.40>) has lowered Flag_RSTA on TerritoryFlag at <9714.855469, 168.180801, 13150.735352>',
      newDateContext(new Date(Date.UTC(2026, 7, 31))),
    );
    expect(event).toMatchObject({
      eventType: 'FLAG_LOWERED',
      actorGameId: 'player-1',
      actorPosition: '9713.25, 167.81, 13149.40',
      targetPosition: '9714.855469, 168.180801, 13150.735352',
      objectType: 'Flag_RSTA',
      parseStatus: 'OK',
    });
  });

  test('same file identity/offset/action on different days gets a different event key while replay stays stable', () => {
    const rawLine = 'Player "Alpha" (id=abc pos=<1, 2, 3>) has raised Flag_Base on TerritoryFlag at <4, 5, 6>';
    const dayOne = new Date('2026-08-30T12:00:00.000Z');
    const dayTwo = new Date('2026-08-31T12:00:00.000Z');
    const first = computeEventKey('guild', 'conn', 'DayZServer.ADM', 128, rawLine, dayOne);
    expect(computeEventKey('guild', 'conn', 'DayZServer.ADM', 128, rawLine, dayOne)).toBe(first);
    expect(computeEventKey('guild', 'conn', 'DayZServer.ADM', 128, rawLine, dayTwo)).not.toBe(first);
  });

  test('same-size completed file with newer mtime is treated as a reused generation', () => {
    const cursor = { lastModifiedAt: 100, lastKnownSize: 4096n, processedByteOffset: 4096n };
    expect(shouldRestartReusedAdmFile({ name: 'DayZServer.ADM', path: '/DayZServer.ADM', size: 4096, modified_at: 101 }, cursor)).toBe(true);
    expect(shouldRestartReusedAdmFile({ name: 'DayZServer.ADM', path: '/DayZServer.ADM', size: 4097, modified_at: 101 }, cursor)).toBe(false);
    expect(shouldRestartReusedAdmFile({ name: 'DayZServer.ADM', path: '/DayZServer.ADM', size: 4096, modified_at: 100 }, cursor)).toBe(false);
  });

  test('LOWERED persistence shares the raw/canonical event key and cursor is not advanced if canonical persistence fails', async () => {
    const input = [
      'AdminLog started on 2026-08-31',
      '12:42:51 | Player "Survivor" (id=game-a pos=<1, 2, 3>) has lowered Flag_Base on TerritoryFlag at <4, 5, 6>',
      '',
    ].join('\n');
    const result = ingestFullFile(input, 0, { fileName: 'DayZServer.ADM' });
    const admRows: any[] = [];
    const flagRows: any[] = [];
    let cursorWrites = 0;
    const successClient: any = {
      admEvent: { createMany: async ({ data }: any) => { admRows.push(...data); return { count: data.length }; } },
      flagActivityEvent: { createMany: async ({ data }: any) => { flagRows.push(...data); return { count: data.length }; } },
      admSourceCursor: { upsert: async () => { cursorWrites += 1; return {}; } },
      $transaction: async (fn: any) => fn(successClient),
    };
    await persistAdmEvents(successClient, { guildId: 'guild-a', nitradoConnId: 'conn-a' }, {
      fileIdentity: 'DayZServer.ADM', fileName: 'DayZServer.ADM', lastModifiedAt: 1, fileSize: Buffer.byteLength(input),
    }, result, null);
    expect(flagRows).toHaveLength(1);
    expect(flagRows[0].action).toBe('LOWERED');
    expect(flagRows[0].eventKey).toBe(admRows[0].eventKey);
    expect(cursorWrites).toBe(1);

    let failingCursorWrites = 0;
    const failingClient: any = {
      admEvent: { createMany: async () => ({ count: 1 }) },
      flagActivityEvent: { createMany: async () => { throw new Error('flag persistence failed'); } },
      admSourceCursor: { upsert: async () => { failingCursorWrites += 1; return {}; } },
      $transaction: async (fn: any) => fn(failingClient),
    };
    await expect(persistAdmEvents(failingClient, { guildId: 'guild-a', nitradoConnId: 'conn-a' }, {
      fileIdentity: 'DayZServer.ADM', fileName: 'DayZServer.ADM', lastModifiedAt: 1, fileSize: Buffer.byteLength(input),
    }, result, null)).rejects.toThrow('flag persistence failed');
    expect(failingCursorWrites).toBe(0);
  });
});
