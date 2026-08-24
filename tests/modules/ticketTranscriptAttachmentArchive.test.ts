import {
  archiveTranscriptAttachments,
  isInlineTranscriptImage,
  type TranscriptArchivedAttachment,
} from '../../src/modules/tickets/transcriptAttachmentArchive';

function attachment(overrides: Partial<TranscriptArchivedAttachment> = {}): TranscriptArchivedAttachment {
  return {
    id: '222222222222222222',
    name: 'proof.png',
    url: 'https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/proof.png?ex=123&is=456&hm=abc',
    contentType: 'image/png',
    size: 4,
    archivedDataUrl: null,
    ...overrides,
  };
}

function fakeResponse(bytes: number[], contentType: string, status = 200): Response {
  const body = Buffer.from(bytes);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        const key = name.toLowerCase();
        if (key === 'content-type') return contentType;
        if (key === 'content-length') return String(body.length);
        return null;
      },
    } as Headers,
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

describe('ticket transcript attachment archive', () => {
  it('archives a Discord image as durable inline data and reports exact bytes', async () => {
    const item = attachment();
    const fetchMock = jest.fn(async () => fakeResponse([1, 2, 3, 4], 'image/png'));

    const stats = await archiveTranscriptAttachments([{ attachments: [item] }], fetchMock);

    expect(stats).toEqual({ attachmentCount: 1, archivedBytes: 4 });
    expect(item.contentType).toBe('image/png');
    expect(item.archivedDataUrl).toBe('data:image/png;base64,AQIDBA==');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('rejects non-Discord attachment hosts before any network request', async () => {
    const item = attachment({ url: 'https://example.com/attachments/111/222/proof.png' });
    const fetchMock = jest.fn(async () => fakeResponse([1, 2, 3, 4], 'image/png'));

    await expect(archiveTranscriptAttachments([{ attachments: [item] }], fetchMock))
      .rejects.toThrow('erlaubten Discord-CDN-Host');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the downloaded bytes do not match Discord metadata', async () => {
    const item = attachment({ size: 5 });
    const fetchMock = jest.fn(async () => fakeResponse([1, 2, 3, 4], 'image/png'));

    await expect(archiveTranscriptAttachments([{ attachments: [item] }], fetchMock))
      .rejects.toThrow('nicht vollstaendig geladen');
    expect(item.archivedDataUrl).toBeNull();
  });

  it('forces non-image attachments to download-safe octet-stream data URLs', async () => {
    const item = attachment({ name: 'notes.txt', contentType: 'text/plain', size: 3 });
    const fetchMock = jest.fn(async () => fakeResponse([65, 66, 67], 'text/plain'));

    await archiveTranscriptAttachments([{ attachments: [item] }], fetchMock);

    expect(item.contentType).toBe('text/plain');
    expect(item.archivedDataUrl).toBe('data:application/octet-stream;base64,QUJD');
  });

  it('only allows safe raster image types for inline transcript rendering', () => {
    expect(isInlineTranscriptImage('image/png')).toBe(true);
    expect(isInlineTranscriptImage('image/jpeg')).toBe(true);
    expect(isInlineTranscriptImage('image/webp')).toBe(true);
    expect(isInlineTranscriptImage('image/svg+xml')).toBe(false);
    expect(isInlineTranscriptImage('text/html')).toBe(false);
  });
});
