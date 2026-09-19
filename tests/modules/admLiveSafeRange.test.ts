const findConnections = jest.fn();
const cursorFindFirst = jest.fn();
const cursorFindUnique = jest.fn();
const eventFindFirst = jest.fn();
const feedUpdateMany = jest.fn();
const resolveProfile = jest.fn();
const recordSourceError = jest.fn();
const listDir = jest.fn();
const downloadFileRange = jest.fn();
const persistAdmEvents = jest.fn();
const ingestChunk = jest.fn();
const verifyChallenges = jest.fn();
const readBinding = jest.fn();
const withFreshBinding = jest.fn();
const isFenceError = jest.fn();

const BINDING = {
  id: 'conn-safe-range',
  guildId: 'guild-safe-range',
  encryptedToken: 'cipher-safe-range',
  nitradoServerId: '19513993',
  bindingVersion: 0,
};

jest.mock('../../src/database/prisma', () => ({
  __esModule: true,
  default: {
    nitradoConnection: { findMany: findConnections },
    gameplayFeedConfig: { updateMany: feedUpdateMany },
    admSourceCursor: { findFirst: cursorFindFirst, findUnique: cursorFindUnique },
    admEvent: { findFirst: eventFindFirst },
  },
}));

jest.mock('../../src/config', () => ({
  config: { security: { encryptionKey: '12345678901234567890123456789012' } },
}));

jest.mock('../../src/utils/security', () => ({ decrypt: jest.fn(() => 'token') }));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../src/modules/nitrado/nitradoClient', () => ({
  NitradoClient: jest.fn().mockImplementation(() => ({ listDir, downloadFileRange })),
}));

jest.mock('../../src/modules/nitrado/adm/profileResolver', () => ({
  resolveAdmProfile: (...args: unknown[]) => resolveProfile(...args),
  recordAdmSourceError: (...args: unknown[]) => recordSourceError(...args),
}));

jest.mock('../../src/modules/nitrado/adm/serverLogIngestor', () => ({
  ingestChunk: (...args: unknown[]) => ingestChunk(...args),
  persistAdmEvents: (...args: unknown[]) => persistAdmEvents(...args),
}));

jest.mock('../../src/modules/linking/admChallengeVerifier', () => ({
  verifyLinkChallengesInAdmText: (...args: unknown[]) => verifyChallenges(...args),
}));

jest.mock('../../src/modules/nitrado/adm/bindingFence', () => ({
  readCurrentAdmBinding: (...args: unknown[]) => readBinding(...args),
  withFreshAdmBinding: (...args: unknown[]) => withFreshBinding(...args),
  isAdmBindingFenceError: (...args: unknown[]) => isFenceError(...args),
}));

import { runAdmLiveSyncOnce } from '../../src/modules/nitrado/adm/admLiveSyncCron';

beforeEach(() => {
  jest.clearAllMocks();
  findConnections.mockResolvedValue([{ id: BINDING.id, guildId: BINDING.guildId }]);
  readBinding.mockResolvedValue(BINDING);
  resolveProfile.mockResolvedValue({ profileDir: '/profiles', timeZone: null, source: 'AUTO' });
  cursorFindFirst.mockResolvedValue(null);
  cursorFindUnique.mockResolvedValue(null);
  eventFindFirst.mockResolvedValue(null);
  feedUpdateMany.mockResolvedValue({ count: 1 });
  recordSourceError.mockResolvedValue(undefined);
  persistAdmEvents.mockResolvedValue({ inserted: 0 });
  verifyChallenges.mockResolvedValue({ verified: 0 });
  ingestChunk.mockImplementation((chunk: string, offset: number) => ({
    events: [],
    newOffset: offset + Buffer.byteLength(chunk, 'utf8'),
    trailingPartial: '',
    wasReset: false,
  }));
  withFreshBinding.mockImplementation(async (_binding: unknown, work: () => Promise<unknown>) => work());
  isFenceError.mockReturnValue(false);
});

describe('ADM live safe Nitrado ranges', () => {
  // Regression (FIX-15): fand das Baseline-Tail-Fenster keinen Zeilenumbruch,
  // markierte der alte Code die GESAMTE Datei als sicher konsumiert
  // (newOffset = file.size) -- obwohl unklar ist, ob die einzige Zeile darin
  // (z.B. ein noch nicht geflushter Session-Header) bereits vollstaendig
  // geschrieben wurde. Ein noch nicht geflushtes erstes Ereignis waere
  // dadurch permanent uebersprungen worden.
  it('baselined defensiv am Fenster-Start statt an file.size, wenn der Tail keinen Zeilenumbruch enthaelt', async () => {
    listDir.mockResolvedValue([{
      name: 'fresh.ADM',
      type: 'file',
      modified_at: 100,
      size: 100,
      path: '/profiles/fresh.ADM',
    }]);
    // Volle Antwort ohne jeden Zeilenumbruch -- z.B. ein noch nicht mit \n
    // abgeschlossener "AdminLog started on ..."-Header.
    downloadFileRange.mockResolvedValue('x'.repeat(100));

    await runAdmLiveSyncOnce();

    expect(persistAdmEvents).toHaveBeenCalledTimes(1);
    expect(persistAdmEvents.mock.calls[0][3]).toEqual(expect.objectContaining({
      newOffset: 0,
    }));
  });

  it('begrenzt auch den Baseline-Tail auf 4048 Byte', async () => {
    listDir.mockResolvedValue([{
      name: 'DayZServer_PS4_x64_2026-08-30_16-04-13.ADM',
      type: 'file',
      modified_at: 100,
      size: 10_000,
      path: '/profiles/DayZServer_PS4_x64_2026-08-30_16-04-13.ADM',
    }]);
    downloadFileRange.mockResolvedValue('ok\n');

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledTimes(1);
    expect(downloadFileRange).toHaveBeenCalledWith(
      BINDING.nitradoServerId,
      '/profiles/DayZServer_PS4_x64_2026-08-30_16-04-13.ADM',
      5952,
      4048,
    );
  });

  it('verwirft eine ignorierte Range fail-closed und blockiert juengere ADM-Dateien am Chronologie-Fence', async () => {
    cursorFindFirst.mockResolvedValue({ lastModifiedAt: 100, fileName: 'older.ADM' });
    listDir.mockResolvedValue([
      {
        name: 'A-large.ADM',
        type: 'file',
        modified_at: 101,
        size: 5000,
        path: '/profiles/A-large.ADM',
      },
      {
        name: 'B-good.ADM',
        type: 'file',
        modified_at: 102,
        size: 3,
        path: '/profiles/B-good.ADM',
      },
    ]);
    downloadFileRange.mockImplementation(async (_service: string, path: string) => {
      if (path.endsWith('/A-large.ADM')) return 'x'.repeat(4049);
      if (path.endsWith('/B-good.ADM')) return 'ok\n';
      throw new Error(`unexpected path ${path}`);
    });

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledTimes(1);
    expect(downloadFileRange).toHaveBeenCalledWith(
      BINDING.nitradoServerId,
      '/profiles/A-large.ADM',
      0,
      4048,
    );
    expect(downloadFileRange).not.toHaveBeenCalledWith(
      BINDING.nitradoServerId,
      '/profiles/B-good.ADM',
      0,
      3,
    );
    expect(persistAdmEvents).not.toHaveBeenCalled();
    expect(recordSourceError).toHaveBeenCalledWith(
      { id: BINDING.id, guildId: BINDING.guildId },
      expect.stringContaining('A-large.ADM'),
    );
  });

  it('begrenzt historische Nachholarbeit auf acht kleine Ranges pro Datei und Poll', async () => {
    cursorFindFirst.mockResolvedValue({ lastModifiedAt: 100, fileName: 'older.ADM' });
    listDir.mockResolvedValue([{
      name: 'backlog.ADM',
      type: 'file',
      modified_at: 101,
      size: 100_000,
      path: '/profiles/backlog.ADM',
    }]);
    downloadFileRange.mockResolvedValue(`${'x'.repeat(4047)}\n`);

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledTimes(8);
    expect(downloadFileRange).toHaveBeenNthCalledWith(
      8,
      BINDING.nitradoServerId,
      '/profiles/backlog.ADM',
      28_336,
      4048,
    );
    expect(persistAdmEvents).toHaveBeenCalledTimes(8);
    expect(recordSourceError).toHaveBeenCalledWith(
      { id: BINDING.id, guildId: BINDING.guildId },
      null,
    );
  });

  it('markiert nur die erste Range einer same-size Rotation als kontrollierten Cursor-Reset', async () => {
    const rotatedCursor = {
      lastModifiedAt: 100,
      lastKnownSize: 10_000n,
      processedByteOffset: 10_000n,
      fileName: 'DayZServer.ADM',
    };
    cursorFindFirst.mockResolvedValue(rotatedCursor);
    cursorFindUnique.mockResolvedValue(rotatedCursor);
    listDir.mockResolvedValue([{
      name: 'DayZServer.ADM',
      type: 'file',
      modified_at: 101,
      size: 10_000,
      path: '/profiles/DayZServer.ADM',
    }]);
    downloadFileRange.mockImplementation(async (
      _service: string,
      _path: string,
      _offset: number,
      length: number,
    ) => `${'x'.repeat(Math.max(0, length - 1))}\n`);

    await runAdmLiveSyncOnce();

    expect(persistAdmEvents).toHaveBeenCalledTimes(3);
    expect(persistAdmEvents.mock.calls[0][3]).toEqual(expect.objectContaining({
      newOffset: 4_048,
      wasReset: true,
    }));
    expect(persistAdmEvents.mock.calls[1][3]).toEqual(expect.objectContaining({
      newOffset: 8_096,
      wasReset: false,
    }));
    expect(persistAdmEvents.mock.calls[2][3]).toEqual(expect.objectContaining({
      newOffset: 10_000,
      wasReset: false,
    }));
  });

  // Regression (FIX-3): eine gleichnamige, aber GROESSER gewordene
  // Ersatzdatei wurde bisher als reines Fortsetzen (kein Reset) behandelt,
  // weil weder shouldRestartReusedAdmFile (Groesse stimmt nicht exakt) noch
  // cursorPastEnd/sourceShrank (Datei ist groesser, nicht kleiner) anschlagen.
  // Der erste Read landete dadurch am ALTEN Byte-Offset -- mitten in der
  // neuen Generation. Der Content-Probe (startsWithAdmSessionHeader) muss
  // diesen ersten, faelschlich fortsetzenden Read verwerfen und ab Byte 0
  // neu beginnen, sobald er eine frische Session-Kopfzeile findet.
  it('rebased eine gleichnamige, groesser gewordene Ersatzdatei anhand einer neuen Session-Kopfzeile im ersten Chunk', async () => {
    const rotatedCursor = {
      lastModifiedAt: 100,
      lastKnownSize: 1_000n,
      processedByteOffset: 1_000n,
      fileName: 'DayZServer.ADM',
    };
    cursorFindFirst.mockResolvedValue(rotatedCursor);
    cursorFindUnique.mockResolvedValue(rotatedCursor);
    listDir.mockResolvedValue([{
      name: 'DayZServer.ADM',
      type: 'file',
      modified_at: 101,
      size: 1_500,
      path: '/profiles/DayZServer.ADM',
    }]);
    downloadFileRange.mockImplementation(async (
      _service: string,
      _path: string,
      offset: number,
      length: number,
    ) => {
      // Der erste (faelschlich fortsetzende) Read bei Byte 1000 landet in
      // Wahrheit bereits in der neuen, groesseren Generation und beginnt
      // dort mit einer frischen Session-Kopfzeile.
      if (offset === 1_000) return 'AdminLog started on 2026-01-02 at 00:00:00\nrest of new session\n';
      return `${'x'.repeat(Math.max(0, length - 1))}\n`;
    });

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledTimes(2);
    expect(downloadFileRange).toHaveBeenNthCalledWith(
      1,
      BINDING.nitradoServerId,
      '/profiles/DayZServer.ADM',
      1_000,
      500,
    );
    // Nach Erkennung der Kopfzeile wird ab Byte 0 neu gelesen statt am alten
    // (jetzt falschen) Offset weiterzumachen.
    expect(downloadFileRange).toHaveBeenNthCalledWith(
      2,
      BINDING.nitradoServerId,
      '/profiles/DayZServer.ADM',
      0,
      1_500,
    );
    // Nur der tatsaechlich verarbeitete (Byte-0-)Chunk wird persistiert -- der
    // verworfene erste Read erzeugt keinen eigenen persistAdmEvents-Aufruf.
    expect(persistAdmEvents).toHaveBeenCalledTimes(1);
    expect(persistAdmEvents.mock.calls[0][3]).toEqual(expect.objectContaining({
      newOffset: 1_500,
      wasReset: true,
    }));
  });

  // Regression (FIX-14): eine einzelne ADM-Zeile, die eine volle
  // RANGE_BYTES-Anfrage ohne Zeilenumbruch fuellt, lieferte bisher
  // newOffset===offset und der Loop brach still ab -- jeder kuenftige Poll
  // forderte denselben Byte-Bereich erneut an und blockierte die Datei
  // permanent, ohne jemals einen Fehler zu melden.
  it('meldet eine ueberlange ADM-Zeile ohne Zeilenumbruch als sichtbaren Fehler statt still zu blockieren', async () => {
    cursorFindFirst.mockResolvedValue({ lastModifiedAt: 100, fileName: 'older.ADM' });
    cursorFindUnique.mockResolvedValue(null);
    listDir.mockResolvedValue([{
      name: 'oneline.ADM',
      type: 'file',
      modified_at: 101,
      size: 10_000,
      path: '/profiles/oneline.ADM',
    }]);
    // Volle 4048-Byte-Antwort ohne einzigen Zeilenumbruch.
    downloadFileRange.mockResolvedValue('x'.repeat(4048));
    // Realistischer ingestChunk-Ersatz: ohne \n im Chunk gibt es keinen
    // vollstaendigen Zeilen-Fortschritt (newOffset bleibt am Chunk-Start).
    ingestChunk.mockImplementation((chunk: string, offset: number) => {
      const lastNewline = chunk.lastIndexOf('\n');
      return {
        events: [],
        newOffset: lastNewline >= 0 ? offset + lastNewline + 1 : offset,
        trailingPartial: lastNewline >= 0 ? chunk.slice(lastNewline + 1) : chunk,
        wasReset: false,
      };
    });

    await runAdmLiveSyncOnce();

    expect(downloadFileRange).toHaveBeenCalledTimes(1);
    // Der Chunk wird trotz fehlendem Fortschritt persistiert (Fingerprint/
    // trailingPartial fuer Diagnose) -- nur der anschliessende Loop-Abbruch
    // wird durch einen sichtbaren Fehler statt eines stillen `break` ersetzt.
    expect(persistAdmEvents).toHaveBeenCalledTimes(1);
    expect(recordSourceError).toHaveBeenCalledWith(
      { id: BINDING.id, guildId: BINDING.guildId },
      expect.stringContaining('oneline.ADM'),
    );
  });
});
