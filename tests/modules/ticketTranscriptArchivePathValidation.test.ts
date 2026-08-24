import {
  archiveTranscriptAttachments,
  type TranscriptArchivedAttachment,
} from '../../src/modules/tickets/transcriptAttachmentArchive';

const base: TranscriptArchivedAttachment = {
  id: '888888888888888888',
  name: 'proof.png',
  url: 'https://cdn.discordapp.com/avatars/111111111111111111/proof.png',
  contentType: 'image/png',
  size: 1,
  archivedDataUrl: null,
};

describe('ticket attachment path validation', () => {
  it('does not fetch arbitrary paths even on an allowed Discord CDN host', async () => {
    const fetchMock = jest.fn();
    await expect(archiveTranscriptAttachments([{ attachments: [{ ...base }] }], fetchMock as typeof fetch))
      .rejects.toThrow('Discord-Attachment-Pfad');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
