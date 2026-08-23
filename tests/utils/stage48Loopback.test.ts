import { requireStage48LoopbackUrl } from '../../src/utils/stage48Loopback';

describe('Stage 48 loopback override guard', () => {
  const previous = process.env.STAGE48_LAB_MODE;

  afterEach(() => {
    if (previous === undefined) delete process.env.STAGE48_LAB_MODE;
    else process.env.STAGE48_LAB_MODE = previous;
  });

  it('requires the explicit lab mode', () => {
    delete process.env.STAGE48_LAB_MODE;
    expect(() => requireStage48LoopbackUrl('http://127.0.0.1:1234')).toThrow(/STAGE48_LAB_MODE/);
  });

  it.each([
    'https://127.0.0.1:1234',
    'http://localhost:1234',
    'http://example.test:1234',
    'http://127.0.0.1:1234?target=remote',
    'http://user:password@127.0.0.1:1234',
  ])('rejects non-canonical or credential-bearing URL %s', rawUrl => {
    process.env.STAGE48_LAB_MODE = '1';
    expect(() => requireStage48LoopbackUrl(rawUrl)).toThrow();
  });

  it.each(['http://127.0.0.1:1234/', 'http://[::1]:4321/base/'])(
    'accepts and normalizes safe loopback URL %s',
    rawUrl => {
      process.env.STAGE48_LAB_MODE = '1';
      expect(requireStage48LoopbackUrl(rawUrl)).not.toMatch(/\/$/);
    },
  );
});
