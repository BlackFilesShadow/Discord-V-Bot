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

  it('korrigiert nur den letzten Zeitanker und laesst den Byte-Cursor unangetastet', async () => {
    cursorFindFirst.mockResolvedValue({
      fileIdentity: 'adm-binding:7:DayZServer_PS4_x64_2026-09-05_21-04-11.ADM',
      fileName: 'DayZServer_PS4_x64_2026-09-05_21-04-11.ADM',
      lastModifiedAt: Math.floor(new Date('2026-09-05T20:43:10.000Z').getTime() / 1000),
      processedByteOffset: 45_383n,
    });
    eventFindFirst.mockResolvedValue({
      id: 'event-last',
      rawLine: '22:43:05 | Player "Void"(id=abc) pos=<7808.7, 5138.3, 215.7>',
      occurredAt: new Date('2026-09-05T22:43:05.000Z'),
    });

    const result = await rebaselineAdmTimeZoneAnchor(
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      'Europe/Berlin',
    );

    expect(result.updated).toBe(true);
    expect(result.occurredAt?.toISOString()).toBe('2026-09-05T20:43:05.000Z');
    expect(eventUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'event-last', guildId: 'guild-1', nitradoConnId: 'conn-1' }),
      data: { occurredAt: new Date('2026-09-05T20:43:05.000Z') },
    }));
    expect(cursorFindFirst).toHaveBeenCalledTimes(1);
  });

  it('schreibt nichts erneut wenn der letzte Zeitanker bereits zur Zeitzone passt', async () => {
    cursorFindFirst.mockResolvedValue({
      fileIdentity: 'adm-binding:7:DayZServer_PS4_x64_2026-09-05_21-04-11.ADM',
      fileName: 'DayZServer_PS4_x64_2026-09-05_21-04-11.ADM',
      lastModifiedAt: Math.floor(new Date('2026-09-05T20:43:10.000Z').getTime() / 1000),
      processedByteOffset: 45_383n,
    });
    eventFindFirst.mockResolvedValue({
      id: 'event-last',
      rawLine: '22:43:05 | Player "Void"(id=abc) pos=<7808.7, 5138.3, 215.7>',
      occurredAt: new Date('2026-09-05T20:43:05.000Z'),
    });

    const result = await rebaselineAdmTimeZoneAnchor(
      { guildId: 'guild-1', nitradoConnId: 'conn-1' },
      'Europe/Berlin',
    );

    expect(result.updated).toBe(false);
    expect(eventUpdateMany).not.toHaveBeenCalled();
  });
});
