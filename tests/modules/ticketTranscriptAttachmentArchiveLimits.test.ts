import {
  archiveTranscriptAttachments,
  type TranscriptArchivedAttachment,
} from '../../src/modules/tickets/transcriptAttachmentArchive';

function item(size: number): TranscriptArchivedAttachment {
  return {
    id: '333333333333333333',
    name: 'large.png',
    url: 'https://media.discordapp.net/attachments/111111111111111111/333333333333333333/large.png',
    contentType: 'image/png',
    size,
    archivedDataUrl: null,
  };
}

describe('ticket transcript attachment archive limits', () => {
  it('rejects an oversized attachment before network access', async () => {
    const fetchMock = jest.fn();
    await expect(archiveTranscriptAttachments([
      { attachments: [item(25 * 1024 * 1024 + 1)] },
    ], fetchMock as typeof fetch)).rejects.toThrow('groesser als 25 MiB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized aggregate before network access', async () => {
    const attachments = Array.from({ length: 5 }, (_, index) => ({
      ...item(21 * 1024 * 1024),
      id: String(333333333333333333n + BigInt(index)),
      name: `large-${index}.png`,
    }));
    const fetchMock = jest.fn();

    await expect(archiveTranscriptAttachments([
      { attachments },
    ], fetchMock as typeof fetch)).rejects.toThrow('zusammen groesser als 100 MiB');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
