import fs from 'node:fs';
import path from 'node:path';
import { validateTranslatedPostImage } from '../../src/modules/ai/translatedPostImage';
import { validateFile } from '../../src/utils/validator';

const root = process.cwd();
const tmp = path.join(root, 'coverage', 'stage44-mime-tmp');

describe('Stage 44 MIME / content validation runtime', () => {
  beforeAll(() => {
    fs.mkdirSync(tmp, { recursive: true });
  });

  afterAll(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('rejects spoofed image MIME vs magic bytes', () => {
    const pngHdr = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const ok = validateTranslatedPostImage({
      buffer: Buffer.concat([pngHdr, Buffer.alloc(32)]),
      mimetype: 'image/png',
    });
    expect(ok).toMatchObject({ ok: true });

    const spoof = validateTranslatedPostImage({
      buffer: Buffer.from('not-an-image-payload'),
      mimetype: 'image/png',
    });
    expect(spoof).toMatchObject({ ok: false });

    const conflict = validateTranslatedPostImage({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x11]),
      mimetype: 'image/png',
    });
    expect(conflict).toMatchObject({ ok: false });
  });

  it('validateFile rejects unknown extensions and accepts JSON/XML structure', async () => {
    const bad = path.join(tmp, 'payload.exe');
    fs.writeFileSync(bad, 'MZ-not-really');
    const unknown = await validateFile(bad);
    expect(unknown.isValid).toBe(false);
    expect(unknown.fileType).toBe('unknown');

    const jsonPath = path.join(tmp, 'ok.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ a: 1 }));
    const json = await validateFile(jsonPath);
    expect(json.fileType).toBe('json');
    expect(json.isValid).toBe(true);

    const xmlPath = path.join(tmp, 'ok.xml');
    fs.writeFileSync(xmlPath, '<?xml version="1.0"?><root><n>1</n></root>');
    const xml = await validateFile(xmlPath);
    expect(xml.fileType).toBe('xml');
    expect(xml.isValid).toBe(true);

    const brokenXml = path.join(tmp, 'bad.xml');
    fs.writeFileSync(brokenXml, '<root><unclosed>');
    const badXml = await validateFile(brokenXml);
    expect(badXml.isValid).toBe(false);
  });

  it('pins upload path size contracts and forbids skip/only', () => {
    const upload = fs.readFileSync(path.join(root, 'src/modules/dashboard/safeUploadValidation.ts'), 'utf8');
    expect(upload).toContain('MAX_VALIDATE_BYTES');
    expect(upload).toContain('isInsideUploadRoot');
    expect(upload).toContain('isInsideRoot');
    const self = fs.readFileSync(
      path.join(root, 'tests/security/uploadMimeContentValidationRuntime.test.ts'),
      'utf8',
    );
    expect(self).not.toMatch(/test\.(only|skip)|describe\.(only|skip)/);
  });
});
