import { archiveTranscriptAttachments, type TranscriptArchivedAttachment } from '../../src/modules/tickets/transcriptAttachmentArchive';

function item(id: string): TranscriptArchivedAttachment {
  return {
    id,
    name: 'image.png',
    url: `https://cdn.discordapp.com/attachments/111111111111111111/${id}/image.png`,
    contentType: 'image/png',
    size: 1,
    archivedDataUrl: null,
  };
}

describe('duplicate archived attachment names', () => {
  it('archives each Discord attachment by its own identity even when filenames match', async () => {
    const first = item('121212121212121212');
    const second = item('131313131313131313');
    let n = 0;
    const fetchMock = jest.fn(async () => {
      n += 1;
      const body = Buffer.from([n]);
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => name.toLowerCase() === 'content-length' ? '1' : 'image/png' },
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      } as unknown as Response;
    });

    await archiveTranscriptAttachments([{ attachments: [first, second] }], fetchMock);
    expect(first.archivedDataUrl).not.toBe(second.archivedDataUrl);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
