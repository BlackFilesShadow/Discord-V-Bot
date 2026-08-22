process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

import path from 'node:path';
import {
  assertInsideRoot,
  assertInsideUploadRoot,
  isInsideRoot,
  isInsideUploadRoot,
  PathBoundaryError,
} from '../../src/utils/pathSafety';
import { config } from '../../src/config';

describe('Stage 42 pathSafety boundary runtime', () => {
  const root = path.resolve('/var/app/uploads');

  it('DENY classic traversal and sibling prefix spoof outside root', () => {
    expect(isInsideRoot(path.join(root, '..', 'etc', 'passwd'), root)).toBe(false);
    expect(isInsideRoot(path.join(root, '..', 'uploads-evil', 'x'), root)).toBe(false);
    expect(isInsideRoot(`${root}-evil${path.sep}x`, root)).toBe(false);
    expect(isInsideRoot(path.join(root, 'ok', 'file.xml'), root)).toBe(true);
    expect(isInsideRoot(root, root)).toBe(true);
  });

  it('assertInsideRoot throws PathBoundaryError and never returns escaped path', () => {
    expect(() => assertInsideRoot(path.join(root, '..', 'secret'), root)).toThrow(PathBoundaryError);
    try {
      assertInsideRoot(path.join(root, '..', 'secret'), root);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PathBoundaryError);
      expect((err as PathBoundaryError).root).toBe(root);
    }
    expect(assertInsideRoot(path.join(root, 'a.xml'), root)).toBe(path.resolve(root, 'a.xml'));
  });

  it('upload root helper binds to config.upload.dir', () => {
    const uploadRoot = path.resolve(config.upload.dir);
    expect(isInsideUploadRoot(path.join(uploadRoot, 'nested', 'ok.bin'))).toBe(true);
    expect(isInsideUploadRoot(path.join(uploadRoot, '..', 'outside.bin'))).toBe(false);
    expect(() => assertInsideUploadRoot(path.join(uploadRoot, '..', 'outside.bin'))).toThrow(PathBoundaryError);
  });
});
