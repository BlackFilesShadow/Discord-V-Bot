import { archiveTranscriptAttachments, type TranscriptArchivedAttachment } from '../../src/modules/tickets/transcriptAttachmentArchive';

const item: TranscriptArchivedAttachment = {
  id: '141414141414141414',
  name: 'huge.png',
  url: 'https://cdn.discordapp.com/attachments/111111111111111111/141414141414141414/huge.png',
  contentType: 'image/png',
  size: 1,
  archivedDataUrl: null,
};

describe('ticket attachment content-length guard', () => {
  it('rejects an oversized response before buffering it', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get(name: string) {
          if (name.toLowerCase() === 'content-length') return String(25 * 1024 * 1024 + 1);
          return 'image/png';
        },
      },
      arrayBuffer: async () => new ArrayBuffer(1),
    } as unknown as Response));

    await expect(archiveTranscriptAttachments([{ attachments: [{ ...item }] }], fetchMock))
      .rejects.toThrow('ueberschreitet beim Download 25 MiB');
  });
});
