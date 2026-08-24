import {
  archiveTranscriptAttachments,
  type TranscriptArchivedAttachment,
} from '../../src/modules/tickets/transcriptAttachmentArchive';

const attachment: TranscriptArchivedAttachment = {
  id: '555555555555555555',
  name: 'evidence.jpg',
  url: 'https://cdn.discordapp.com/attachments/111111111111111111/555555555555555555/evidence.jpg',
  contentType: 'image/jpeg',
  size: 10,
  archivedDataUrl: null,
};

describe('ticket attachment archive network failures', () => {
  it('propagates a clear archival failure and never fabricates archived bytes', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('network unavailable');
    });

    await expect(archiveTranscriptAttachments([
      { attachments: [{ ...attachment }] },
    ], fetchMock)).rejects.toThrow('konnte nicht archiviert werden');
  });
});
