import fs from 'node:fs';
import path from 'node:path';
import { isAdmFileFullyConsumed } from '../../src/modules/nitrado/adm/admLiveSyncCron';

describe('ADM live-sync chronology fence', () => {
  it('only marks a source file complete once its byte cursor reaches the file size', () => {
    expect(isAdmFileFullyConsumed(0, 1)).toBe(false);
    expect(isAdmFileFullyConsumed(32_384, 40_000)).toBe(false);
    expect(isAdmFileFullyConsumed(40_000, 40_000)).toBe(true);
    expect(isAdmFileFullyConsumed(40_001, 40_000)).toBe(true);
    expect(isAdmFileFullyConsumed(-1, 40_000)).toBe(false);
    expect(isAdmFileFullyConsumed(Number.MAX_SAFE_INTEGER + 1, 40_000)).toBe(false);
  });

  it('keeps newer rotated files behind an incomplete or failed older candidate', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/modules/nitrado/adm/admLiveSyncCron.ts'),
      'utf8',
    );
    expect(source).toContain('.sort((a, b) => a.modified_at - b.modified_at || a.name.localeCompare(b.name))');
    expect(source).toContain('const fileComplete = await ingestFile(');
    expect(source).toContain('if (!fileComplete) break;');
    expect(source).toMatch(/catch \(error\)[\s\S]*firstFileError[\s\S]*break;/);
  });
});
