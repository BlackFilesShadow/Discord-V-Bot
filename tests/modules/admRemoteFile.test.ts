import fs from 'fs';
import path from 'path';
import {
  resolveAdmRemoteFilePath,
  selectAdmRemoteFiles,
} from '../../src/modules/nitrado/adm/admRemoteFile';
import { normalizeSourceNewlines } from '../helpers/sourceText';

describe('ADM canonical Nitrado file path handling', () => {
  it('preserves the canonical path returned by file_server/list', () => {
    const files = selectAdmRemoteFiles([
      {
        name: 'DayZServer_PS4.ADM',
        type: 'file',
        modified_at: 123,
        size: 456,
        path: ' /games/example/noftp/dayzps/config/DayZServer_PS4.ADM ',
      },
      {
        name: 'server.RPT',
        type: 'file',
        modified_at: 123,
        size: 456,
        path: '/games/example/noftp/dayzps/config/server.RPT',
      },
      {
        name: 'archive.ADM',
        type: 'dir',
        modified_at: 123,
        size: 0,
        path: '/games/example/noftp/dayzps/config/archive.ADM',
      },
    ]);

    expect(files).toEqual([
      {
        name: 'DayZServer_PS4.ADM',
        modified_at: 123,
        size: 456,
        path: '/games/example/noftp/dayzps/config/DayZServer_PS4.ADM',
      },
    ]);
  });

  it('prefers the canonical listed path over reconstructed profileDir/name', () => {
    expect(resolveAdmRemoteFilePath(
      '/logical/dayzps/config',
      {
        name: 'DayZServer_PS4.ADM',
        modified_at: 1,
        size: 2,
        path: '/games/example/noftp/dayzps/config/DayZServer_PS4.ADM',
      },
    )).toBe('/games/example/noftp/dayzps/config/DayZServer_PS4.ADM');
  });

  it('keeps the old profileDir/name behavior when Nitrado omits path', () => {
    expect(resolveAdmRemoteFilePath(
      '/games/example/dayzps/config/',
      { name: 'DayZServer_PS4.ADM', modified_at: 1, size: 2 },
    )).toBe('/games/example/dayzps/config/DayZServer_PS4.ADM');
  });

  it('does not accept control-character paths from a remote listing', () => {
    expect(resolveAdmRemoteFilePath(
      '/games/example/dayzps/config',
      {
        name: 'DayZServer_PS4.ADM',
        modified_at: 1,
        size: 2,
        path: '/bad/path\nDayZServer_PS4.ADM',
      },
    )).toBe('/games/example/dayzps/config/DayZServer_PS4.ADM');
  });

  it('wires both baseline and incremental reads to the canonical path resolver', () => {
    const live = normalizeSourceNewlines(fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/modules/nitrado/adm/admLiveSyncCron.ts'),
      'utf8',
    ));

    expect(live).toContain('selectAdmRemoteFiles(await client.listDir(conn.nitradoServerId, profile.profileDir))');
    expect((live.match(/resolveAdmRemoteFilePath\(profileDir, file\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(live).not.toContain('`${profileDir}/${file.name}`');
  });
});
