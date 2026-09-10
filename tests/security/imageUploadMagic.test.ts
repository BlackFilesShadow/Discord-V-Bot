import fs from 'node:fs';
import path from 'node:path';
import {
  detectSupportedImageKind,
  validateSupportedImageUpload,
} from '../../src/utils/imageUploadMagic';

function png(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}

function jpeg(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
}

function gif(): Buffer {
  return Buffer.from('GIF89a000000', 'ascii');
}

function webp(): Buffer {
  return Buffer.from('RIFF0000WEBP', 'ascii');
}

describe('shared dashboard image upload magic-byte validation', () => {
  it.each([
    [png(), 'image/png', '.png'],
    [jpeg(), 'image/jpeg', '.jpg'],
    [gif(), 'image/gif', '.gif'],
    [webp(), 'image/webp', '.webp'],
  ])('detects supported image contents independently from client metadata', (buffer, mime, ext) => {
    expect(detectSupportedImageKind(buffer)).toEqual({ mime, ext });
    expect(validateSupportedImageUpload({ buffer, mimetype: mime })).toEqual({
      ok: true,
      kind: { mime, ext },
    });
  });

  it('rejects arbitrary bytes even when the client claims an allowed image MIME', () => {
    expect(validateSupportedImageUpload({
      buffer: Buffer.from('<script>alert(1)</script>'),
      mimetype: 'image/png',
    })).toEqual({ ok: false, error: 'Dateiinhalt ist kein unterstütztes PNG/JPEG/GIF/WebP-Bild.' });
  });

  it('rejects a real image when its claimed MIME conflicts with the content', () => {
    expect(validateSupportedImageUpload({ buffer: png(), mimetype: 'image/jpeg' }))
      .toEqual({ ok: false, error: 'MIME-Type und Bildinhalt stimmen nicht überein.' });
  });

  it('wires content validation into both public dashboard image upload surfaces', () => {
    const root = process.cwd();
    const welcome = fs.readFileSync(path.join(root, 'src/dashboard/routes/v2/welcome.ts'), 'utf8');
    const embeds = fs.readFileSync(path.join(root, 'src/dashboard/routes/v2/embeds.ts'), 'utf8');
    for (const source of [welcome, embeds]) {
      expect(source).toContain("import { validateSupportedImageUpload } from '../../../utils/imageUploadMagic';");
      expect(source).toContain('const imageValidation = validateSupportedImageUpload(file);');
      expect(source).toContain('if (!imageValidation.ok)');
      expect(source.indexOf('validateSupportedImageUpload(file)')).toBeLessThan(source.indexOf('await fs.writeFile'));
    }
  });
});