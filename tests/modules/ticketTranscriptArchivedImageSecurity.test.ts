import {
  archiveTranscriptAttachments,
  isInlineTranscriptImage,
  type TranscriptArchivedAttachment,
} from '../../src/modules/tickets/transcriptAttachmentArchive';

const base: TranscriptArchivedAttachment = {
  id: '444444444444444444',
  name: 'proof.png',
  url: 'https://cdn.discordapp.com/attachments/111111111111111111/444444444444444444/proof.png',
  contentType: 'image/png',
  size: 1,
  archivedDataUrl: null,
};

describe('archived ticket image security boundaries', () => {
  it('does not accept a lookalike Discord hostname', async () => {
    const fetchMock = jest.fn();
    await expect(archiveTranscriptAttachments([{ attachments: [{
      ...base,
      url: 'https://cdn.discordapp.com.evil.example/attachments/111/444/proof.png',
    }] }], fetchMock as typeof fetch)).rejects.toThrow('erlaubten Discord-CDN-Host');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not render SVG or HTML inline', () => {
    expect(isInlineTranscriptImage('image/svg+xml')).toBe(false);
    expect(isInlineTranscriptImage('text/html')).toBe(false);
  });
});
