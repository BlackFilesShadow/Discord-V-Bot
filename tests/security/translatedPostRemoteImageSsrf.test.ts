process.env.DISCORD_TOKEN ||= 'test-token';
process.env.DISCORD_CLIENT_ID ||= 'test-client-id';
process.env.DISCORD_CLIENT_SECRET ||= 'test-secret';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
process.env.SESSION_SECRET ||= 'test-session-secret';

const safeAxiosGet = jest.fn();
const mkdir = jest.fn(async () => undefined);
const writeFile = jest.fn(async () => undefined);
const unlink = jest.fn(async () => undefined);

jest.mock('../../src/utils/ssrf', () => ({ safeAxiosGet }));
jest.mock('node:fs', () => ({ promises: { mkdir, writeFile, unlink } }));

import {
  MAX_TRANSLATED_POST_IMAGE_BYTES,
  saveTranslatedPostImageFromUrl,
} from '../../src/modules/ai/translatedPostImage';

const GUILD_ID = '123456789012345678';

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    Buffer.alloc(24),
  ]);
}

describe('translated post remote image ingestion', () => {
  beforeEach(() => jest.clearAllMocks());

  it('uses the SSRF-safe client, validates content and persists a managed image', async () => {
    safeAxiosGet.mockResolvedValue({ data: pngBytes(), headers: { 'content-type': 'image/png' } });

    const ref = await saveTranslatedPostImageFromUrl(GUILD_ID, 'https://images.example.test/pic.png');

    expect(safeAxiosGet).toHaveBeenCalledWith(
      'https://images.example.test/pic.png',
      expect.objectContaining({
        responseType: 'arraybuffer',
        maxContentLength: MAX_TRANSLATED_POST_IMAGE_BYTES,
        maxBodyLength: MAX_TRANSLATED_POST_IMAGE_BYTES,
      }),
    );
    expect(ref).toMatch(/^upload:translated-posts\/123456789012345678\/[0-9a-f-]{36}\.png$/i);
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a remote response whose MIME conflicts with its magic bytes', async () => {
    safeAxiosGet.mockResolvedValue({ data: pngBytes(), headers: { 'content-type': 'image/jpeg' } });

    await expect(saveTranslatedPostImageFromUrl(GUILD_ID, 'https://images.example.test/spoof.jpg'))
      .rejects.toThrow(/Dateityp und Bildinhalt/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rejects arbitrary remote bytes instead of persisting them', async () => {
    safeAxiosGet.mockResolvedValue({ data: Buffer.from('<svg onload=alert(1)>'), headers: { 'content-type': 'image/png' } });

    await expect(saveTranslatedPostImageFromUrl(GUILD_ID, 'https://images.example.test/not-image.png'))
      .rejects.toThrow(/Nur PNG, JPEG, GIF oder WebP/);
    expect(writeFile).not.toHaveBeenCalled();
  });
});
