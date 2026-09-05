const cursorFindFirst = jest.fn();
const eventFindFirst = jest.fn();
const eventUpdateMany = jest.fn();

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    admSourceCursor: { findFirst: cursorFindFirst },
    admEvent: { findFirst: eventFindFirst, updateMany: eventUpdateMany },
  },
}));

import {
  rebaselineAdmTimeZoneAnchor,
  resolveAdmWallClockNearReference,
  restoreAdmWallClockLine,
} from '../../src/modules/nitrado/adm/timeZoneRebaseline';

beforeEach(() => {
  jest.clearAllMocks();
  eventUpdateMany.mockResolvedValue({ count: 1 });
});

describe('ADM timezone normalization', () => {
  it('normalisiert Europe/Berlin im Sommer DST-sicher nach UTC', () => {
    const occurredAt = resolveAdmWallClockNearReference(
      '18:00:12 | Player "Alpha"(id=1) is connected',
      'DayZServer_PS4_x64_2026-07-01_17-55-00.ADM',
      'Europe/Berlin',
      new Date('2026-07-01T16:00:15.000Z'),
    );

    expect(occurredAt?.toISOString()).toBe('2026-07-01T16:00:12.000Z');
  });

  it('normalisiert Europe/Berlin im Winter mit dem korrekten UTC+1 Offset', () => {
    const occurredAt = resolveAdmWallClockNearReference(
      '18:00:12 | Player "Alpha"(id=1) is connected',
      'DayZServer_PS4_x64_2026-01-15_17-55-00.ADM',
      'Europe/Berlin',
      new Date('2026-01-15T17:00:15.000Z'),
    );

    expect(occurredAt?.toISOString()).toBe('2026-01-15T17:00:12.000Z');
  });

  it('waehlt bei einer weiterlaufenden ADM-Datei den Tag nahe der echten Dateimodifikation', () => {
    const occurredAt = resolveAdmWallClockNearReference(
      '00:05:10 | Player "Alpha"(id=1) is connected',
      'DayZServer_PS4_x64_2026-09-05_21-04-11.ADM',
      'Europe/Berlin',
      new Date('2026-09-05T22:05:12.000Z'),
    );

    // 00:05 CEST am Folgetag entspricht 22:05 UTC am 05.09.
    expect(occurredAt?.toISOString()).toBe('2026-09-05T22:05:10.000Z');
  });

  it('rekonstruiert aus produktiv gespeichertem rawLine den fehlenden ADM-Zeitpraefix', () => {
    const rawLine = restoreAdmWallClockLine(
      'Player "Balu_cleo" (id=abc) performed EmoteSitA',
      new Date('2026-09-06T01:08:45.000Z'),
      null,
    );

    expect(rawLine).toBe('01:08:45 | Player "Balu_cleo" (id=abc) performed EmoteSitA');
  });

  it('korrigiert den produktiven Null-Zeitzonen-Anchor ohne Timestamp im rawLine', async () => {
    cursorFindFirst.mockResolvedValue({
      fileIdentity: 'DayZServer_PS4_x64_2026-09-06_00-06-46.ADM',
      fileName: 'DayZServer_PS4_x64_2026-09-06_00-06-46.ADM',
      lastModifiedAt: Math.floor(new Date('2026-09-05T23:08:50.000Z').getTime() / 1000),
      processedByteOffset: 27_320n,
    });
    eventFindFirst.mockResolvedValue({
      id: 'event-last',
      rawLine: 'Player "Balu_cleo" (id=abc) performed EmoteSitA',
      // Vor dem Fix wurde die Server-Wanduhr 01:08:45 bei timeZone=null als UTC gespeichert.
      occurredAt: new Date('2026-09-06T01:08:45.000Z'),
    });

    const result = await rebaselineAdmTimeZoneAnchor(
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      null,
      'Europe/Berlin',
    );

    expect(result.updated).toBe(true);
    expect(result.occurredAt?.toISOString()).toBe('2026-09-05T23:08:45.000Z');
    expect(eventUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'event-last', guildId: 'guild-1', nitradoConnId: 'conn-1' }),
      data: { occurredAt: new Date('2026-09-05T23:08:45.000Z') },
    }));
    expect(cursorFindFirst).toHaveBeenCalledTimes(1);
  });

  it('heilt einen bereits um +24h verschobenen Europe/Berlin-Continuation-Anchor idempotent', async () => {
    cursorFindFirst.mockResolvedValue({
      fileIdentity: 'DayZServer_PS4_x64_2026-09-06_00-06-46.ADM',
      fileName: 'DayZServer_PS4_x64_2026-09-06_00-06-46.ADM',
      lastModifiedAt: Math.floor(new Date('2026-09-05T23:23:55.000Z').getTime() / 1000),
      processedByteOffset: 32_377n,
    });
    eventFindFirst.mockResolvedValue({
      id: 'event-day-shifted',
      rawLine: 'Player "x12GoldenYearsx" (id=abc)[HP: 88] hit by Player "SchmutzfussRICK" (id=def)',
      // Produktionsbefund nach dem ersten Fix: korrekte Uhrzeit, aber exakt +24h.
      occurredAt: new Date('2026-09-06T23:23:54.000Z'),
    });

    const result = await rebaselineAdmTimeZoneAnchor(
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      'Europe/Berlin',
      'Europe/Berlin',
    );

    expect(result.updated).toBe(true);
    expect(result.occurredAt?.toISOString()).toBe('2026-09-05T23:23:54.000Z');
    expect(eventUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: { occurredAt: new Date('2026-09-05T23:23:54.000Z') },
    }));
  });

  it('schreibt nichts erneut wenn der letzte produktive Anchor bereits zur Zeitzone passt', async () => {
    cursorFindFirst.mockResolvedValue({
      fileIdentity: 'DayZServer_PS4_x64_2026-09-06_00-06-46.ADM',
      fileName: 'DayZServer_PS4_x64_2026-09-06_00-06-46.ADM',
      lastModifiedAt: Math.floor(new Date('2026-09-05T23:23:55.000Z').getTime() / 1000),
      processedByteOffset: 32_377n,
    });
    eventFindFirst.mockResolvedValue({
      id: 'event-correct',
      rawLine: 'Player "x12GoldenYearsx" (id=abc)[HP: 88] hit by Player "SchmutzfussRICK" (id=def)',
      occurredAt: new Date('2026-09-05T23:23:54.000Z'),
    });

    const result = await rebaselineAdmTimeZoneAnchor(
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      'Europe/Berlin',
      'Europe/Berlin',
    );

    expect(result.updated).toBe(false);
    expect(result.occurredAt?.toISOString()).toBe('2026-09-05T23:23:54.000Z');
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });
});
