import { shouldRestartReusedAdmFile } from '../../src/modules/nitrado/adm/admLiveSyncCron';

test('newer same-size completed ADM file is restarted from byte zero', () => {
  const cursor = { lastModifiedAt: 100, lastKnownSize: 4096n, processedByteOffset: 4096n };
  expect(shouldRestartReusedAdmFile({ name: 'DayZServer.ADM', size: 4096, modified_at: 101 }, cursor)).toBe(true);
  expect(shouldRestartReusedAdmFile({ name: 'DayZServer.ADM', size: 4097, modified_at: 101 }, cursor)).toBe(false);
});
