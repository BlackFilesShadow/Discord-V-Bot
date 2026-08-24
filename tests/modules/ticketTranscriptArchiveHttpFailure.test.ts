import {
  archiveTranscriptAttachments,
  type TranscriptArchivedAttachment,
} from '../../src/modules/tickets/transcriptAttachmentArchive';

function response(status: number): Response {
  return {
    ok: false,
    status,
    headers: { get: () => null } as unknown as Headers,
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as Response;
}

const attachment: TranscriptArchivedAttachment = {
  id: '666666666666666666',
  name: 'expired.png',
  url: 'https://cdn.discordapp.com/attachments/111111111111111111/666666666666666666/expired.png',
  contentType: 'image/png',
  size: 1,
  archivedDataUrl: null,
};

describe('ticket attachment archive HTTP failures', () => {
  it('fails closed when Discord no longer serves the attachment', async () => {
    const fetchMock = jest.fn(async () => response(404));
    await expect(archiveTranscriptAttachments([{ attachments: [{ ...attachment }] }], fetchMock))
      .rejects.toThrow('HTTP 404');
  });
});
