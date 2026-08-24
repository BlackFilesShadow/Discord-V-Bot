import {
  archiveTranscriptAttachments,
  type TranscriptArchivedAttachment,
} from '../../src/modules/tickets/transcriptAttachmentArchive';

const attachment: TranscriptArchivedAttachment = {
  id: '777777777777777777',
  name: 'proof.webp',
  url: 'https://cdn.discordapp.com/attachments/111111111111111111/777777777777777777/proof.webp',
  contentType: null,
  size: 2,
  archivedDataUrl: null,
};

describe('ticket attachment MIME fallback', () => {
  it('uses the Discord response MIME when message metadata has none', async () => {
    const body = Buffer.from([1, 2]);
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name: string) {
          if (name.toLowerCase() === 'content-type') return 'image/webp';
          if (name.toLowerCase() === 'content-length') return '2';
          return null;
        },
      },
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    } as unknown as Response));

    const copy = { ...attachment };
    await archiveTranscriptAttachments([{ attachments: [copy] }], fetchMock);
    expect(copy.contentType).toBe('image/webp');
    expect(copy.archivedDataUrl).toBe('data:image/webp;base64,AQI=');
  });
});
