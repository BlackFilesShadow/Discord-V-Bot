import { validateTranslatedPostImage } from '../../src/modules/ai/translatedPostImage';

describe('translated post image validation', () => {
  test('accepts image magic bytes instead of trusting the filename', () => {
    const png = Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), Buffer.alloc(16)]);
    expect(validateTranslatedPostImage({ buffer: png, mimetype: 'image/png' })).toMatchObject({ ok: true, kind: { ext: 'png' } });
  });

  test('rejects mime spoofing and arbitrary binary data', () => {
    const fake = Buffer.from('this is not an image');
    expect(validateTranslatedPostImage({ buffer: fake, mimetype: 'image/png' })).toMatchObject({ ok: false });
  });

  test('rejects an image when declared mime conflicts with its magic bytes', () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00]);
    expect(validateTranslatedPostImage({ buffer: jpg, mimetype: 'image/png' })).toMatchObject({ ok: false });
  });
});
