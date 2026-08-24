import { archiveTranscriptAttachments, type TranscriptArchivedAttachment } from '../../src/modules/tickets/transcriptAttachmentArchive';

const item: TranscriptArchivedAttachment = {
  id: '151515151515151515',
  name: 'runtime.png',
  url: 'https://cdn.discordapp.com/attachments/111111111111111111/151515151515151515/runtime.png',
  contentType: 'image/png',
  size: 0,
  archivedDataUrl: null,
};

describe('ticket archive runtime byte accounting', () => {
  it('keeps the unknown-size path bounded by the per-attachment guard', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    } as unknown as Response));

    const copy = { ...item };
    await expect(archiveTranscriptAttachments([{ attachments: [copy] }], fetchMock))
      .resolves.toEqual({ attachmentCount: 1, archivedBytes: 3 });
    expect(copy.archivedDataUrl).toBe('data:image/png;base64,AQID');
  });
});
