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

import type { Attachment } from 'discord.js';
import { MAX_MEDIA_BYTES, saveAttachment } from '../../src/modules/ai/mediaStorage';

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

describe('mediaStorage SSRF/size hardening', () => {
  it('downloads through safeAxiosGet with a hard response-size cap', async () => {
    safeAxiosGet.mockResolvedValue({ data: Buffer.from('safe-image-bytes') });

    const result = await saveAttachment(attachment(), 'triggers', '123456789012345678', 'trigger-1');

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
    safeAxiosGet.mockResolvedValue({ data: Buffer.alloc(MAX_MEDIA_BYTES + 1) });

    const result = await saveAttachment(attachment({ size: 1 }), 'welcome', '123456789012345678', 'welcome');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('zu groß');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rejects declared oversize files before making a network request', async () => {
    const result = await saveAttachment(
      attachment({ size: MAX_MEDIA_BYTES + 1 }),
      'triggers',
      '123456789012345678',
      'trigger-2',
    );

    expect(result.ok).toBe(false);
    expect(safeAxiosGet).not.toHaveBeenCalled();
  });
});
