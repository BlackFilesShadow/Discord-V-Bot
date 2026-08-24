import {
  archiveTranscriptAttachments,
  type TranscriptArchivedAttachment,
} from '../../src/modules/tickets/transcriptAttachmentArchive';

const item: TranscriptArchivedAttachment = {
  id: '999999999999999999',
  name: 'proof.png',
  url: 'https://CDN.DISCORDAPP.COM/attachments/111111111111111111/999999999999999999/proof.png',
  contentType: 'image/png',
  size: 1,
  archivedDataUrl: null,
};

describe('ticket attachment CDN hostname normalization', () => {
  it('accepts a case-insensitive canonical Discord CDN hostname', async () => {
    const body = Buffer.from([1]);
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '1' : 'image/png' },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response));

    const copy = { ...item };
    await expect(archiveTranscriptAttachments([{ attachments: [copy] }], fetchMock)).resolves.toEqual({ attachmentCount: 1, archivedBytes: 1 });
  });
});
