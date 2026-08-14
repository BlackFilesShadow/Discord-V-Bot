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
jest.mock('fs/promises', () => ({ mkdir, writeFile, unlink }));

import path from 'node:path';
import type { Attachment } from 'discord.js';
import {
  MEDIA_BASE_DIR,
  MAX_MEDIA_BYTES,
  deleteMediaIfLocal,
  saveAttachment,
  saveRemoteMedia,
} from '../../src/modules/ai/mediaStorage';

const GUILD_ID = '123456789012345678';

function pngBytes(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),
    Buffer.alloc(24),
  ]);
}

function attachment(overrides: Record<string, unknown> = {}): Attachment {
  return {
    name: 'image.png',
    contentType: 'image/png',
    size: 1024,
    url: 'https://cdn.discordapp.com/attachments/1/2/image.png',
    ...overrides,
  } as unknown as Attachment;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('mediaStorage SSRF/size/content hardening', () => {
  it('downloads through safeAxiosGet with a hard response-size cap', async () => {
    safeAxiosGet.mockResolvedValue({ data: pngBytes(), headers: { 'content-type': 'image/png' } });

    const result = await saveAttachment(attachment(), 'triggers', GUILD_ID, 'trigger-1');

    expect(result.ok).toBe(true);
    expect(safeAxiosGet).toHaveBeenCalledWith(
      'https://cdn.discordapp.com/attachments/1/2/image.png',
      expect.objectContaining({
        responseType: 'arraybuffer',
        maxContentLength: MAX_MEDIA_BYTES,
        maxBodyLength: MAX_MEDIA_BYTES,
      }),
    );
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it('does not trust the declared attachment size after download', async () => {
    safeAxiosGet.mockResolvedValue({ data: Buffer.alloc(MAX_MEDIA_BYTES + 1), headers: {} });

    const result = await saveAttachment(attachment({ size: 1 }), 'welcome', GUILD_ID, 'welcome');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('zu groß');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rejects declared oversize files before making a network request', async () => {
    const result = await saveAttachment(
      attachment({ size: MAX_MEDIA_BYTES + 1 }),
      'triggers',
      GUILD_ID,
      'trigger-2',
    );

    expect(result.ok).toBe(false);
    expect(safeAxiosGet).not.toHaveBeenCalled();
  });

  it('rejects spoofed image content even when filename and declared MIME look valid', async () => {
    safeAxiosGet.mockResolvedValue({
      data: Buffer.from('<html>not an image</html>'),
      headers: { 'content-type': 'image/png' },
    });

    const result = await saveAttachment(attachment(), 'triggers', GUILD_ID, 'trigger-spoof');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('Dateiinhalt');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rejects a response MIME that conflicts with the downloaded magic bytes', async () => {
    safeAxiosGet.mockResolvedValue({ data: pngBytes(), headers: { 'content-type': 'image/jpeg' } });

    const result = await saveAttachment(attachment(), 'welcome', GUILD_ID, 'mime-spoof');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('MIME-Type');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('materializes remote media through the SSRF-safe client and derives the local extension from magic bytes', async () => {
    safeAxiosGet.mockResolvedValue({ data: pngBytes(), headers: { 'content-type': 'image/png' } });

    const result = await saveRemoteMedia('https://media.example.test/no-extension', 'triggers', GUILD_ID, 'remote-1');

    expect(result.ok).toBe(true);
    expect(safeAxiosGet).toHaveBeenCalledWith(
      'https://media.example.test/no-extension',
      expect.objectContaining({
        responseType: 'arraybuffer',
        maxContentLength: MAX_MEDIA_BYTES,
        maxBodyLength: MAX_MEDIA_BYTES,
      }),
    );
    const expectedPrefix = path.join(MEDIA_BASE_DIR, 'triggers', GUILD_ID, 'remote-1_');
    expect(result.localPath?.startsWith(expectedPrefix)).toBe(true);
    expect(result.localPath?.endsWith('.png')).toBe(true);
    expect(writeFile).toHaveBeenCalledWith(result.localPath, expect.any(Buffer), { mode: 0o640 });
  });

  it('creates a fresh local path for every ingestion so replacements cannot overwrite the active file', async () => {
    safeAxiosGet.mockResolvedValue({ data: pngBytes(), headers: { 'content-type': 'image/png' } });

    const first = await saveRemoteMedia('https://media.example.test/a', 'triggers', GUILD_ID, 'same-trigger');
    const second = await saveRemoteMedia('https://media.example.test/b', 'triggers', GUILD_ID, 'same-trigger');

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.localPath).toBeTruthy();
    expect(second.localPath).toBeTruthy();
    expect(first.localPath).not.toBe(second.localPath);
  });

  it('rejects remote media when response MIME conflicts with magic bytes', async () => {
    safeAxiosGet.mockResolvedValue({ data: pngBytes(), headers: { 'content-type': 'video/mp4' } });

    const result = await saveRemoteMedia('https://media.example.test/spoof', 'triggers', GUILD_ID, 'remote-spoof');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('MIME-Type');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rejects oversized remote bodies even if the HTTP client mock returns them', async () => {
    safeAxiosGet.mockResolvedValue({ data: Buffer.alloc(MAX_MEDIA_BYTES + 1), headers: { 'content-type': 'image/png' } });

    const result = await saveRemoteMedia('https://media.example.test/large', 'triggers', GUILD_ID, 'remote-large');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('zu groß');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('never deletes a sibling path that merely shares the media-root prefix', async () => {
    await deleteMediaIfLocal(`${MEDIA_BASE_DIR}-backup/secret.png`);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('deletes a file only when its resolved path is truly inside the managed media root', async () => {
    const managed = path.join(MEDIA_BASE_DIR, 'triggers', GUILD_ID, 'remote-1.png');
    await deleteMediaIfLocal(managed);
    expect(unlink).toHaveBeenCalledWith(path.resolve(managed));
  });
});
