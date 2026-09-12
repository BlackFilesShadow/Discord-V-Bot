import { createHash } from 'node:crypto';
import {
  DISCORD_MAX_RELAY_ATTACHMENT_BYTES,
  prepareTicketRelayAttachments,
  preparedTicketRelayFiles,
  verifyTicketRelayAttachments,
} from '../../src/modules/ticket/ticketAttachmentRelay';

const fetchMock = jest.fn();

function response(bytes: Buffer, status = 200, declaredLength: number | null = bytes.length) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => name.toLowerCase() === 'content-length' && declaredLength !== null
        ? String(declaredLength)
        : null,
    },
    arrayBuffer: async () => arrayBuffer,
  } as unknown as Response;
}

beforeAll(() => {
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: fetchMock,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
});

describe('ticketAttachmentRelay', () => {
  it.each([
    ['image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['notes.txt', Buffer.from('äöü emoji 😀 exakt', 'utf8')],
    ['animation.gif', Buffer.from('GIF89a', 'ascii')],
    ['clip.mp4', Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70])],
  ])('laedt %s als unveraenderte Bytes und berechnet SHA-256', async (name, bytes) => {
    fetchMock.mockResolvedValueOnce(response(bytes));
    const prepared = await prepareTicketRelayAttachments([{
      id: '222222222222222222',
      name,
      url: `https://cdn.discordapp.com/attachments/111111111111111111/222222222222222222/${name}?ex=abc`,
      size: bytes.length,
    }]);

    expect(prepared).toHaveLength(1);
    expect(prepared[0].name).toBe(name);
    expect(prepared[0].bytes.equals(bytes)).toBe(true);
    expect(prepared[0].sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(preparedTicketRelayFiles(prepared)[0]).toEqual({ attachment: bytes, name });
  });

  it('lehnt Nicht-Discord-CDN-URLs vor jedem Download fail-closed ab', async () => {
    await expect(prepareTicketRelayAttachments([{
      id: '1',
      name: 'proof.png',
      url: 'https://example.com/attachments/1/2/proof.png',
      size: 4,
    }])).rejects.toThrow('Discord-CDN-Host');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lehnt Dateien oberhalb der etablierten 25-MiB-Grenze vor dem Download ab', async () => {
    await expect(prepareTicketRelayAttachments([{
      id: '1',
      name: 'large.bin',
      url: 'https://cdn.discordapp.com/attachments/1/2/large.bin',
      size: DISCORD_MAX_RELAY_ATTACHMENT_BYTES + 1,
    }])).rejects.toThrow('groesser als 25 MiB');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lehnt eine abweichende Content-Length ab', async () => {
    const bytes = Buffer.from('same-bytes', 'utf8');
    fetchMock.mockResolvedValueOnce(response(bytes, 200, bytes.length + 1));
    await expect(prepareTicketRelayAttachments([{
      id: '1',
      name: 'proof.txt',
      url: 'https://cdn.discordapp.com/attachments/1/2/proof.txt',
      size: bytes.length,
    }])).rejects.toThrow('Content-Length');
  });

  it('verifiziert den von Discord erzeugten Ziel-Anhang byte-identisch per SHA-256', async () => {
    const bytes = Buffer.from('identical payload 😀', 'utf8');
    fetchMock
      .mockResolvedValueOnce(response(bytes))
      .mockResolvedValueOnce(response(bytes));

    const prepared = await prepareTicketRelayAttachments([{
      id: '1',
      name: 'proof.txt',
      url: 'https://cdn.discordapp.com/attachments/10/11/proof.txt?source=1',
      size: bytes.length,
    }]);

    await expect(verifyTicketRelayAttachments([{
      name: 'proof.txt',
      url: 'https://cdn.discordapp.com/attachments/20/21/proof.txt?relay=1',
      size: bytes.length,
    }], prepared)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('bricht bei gleicher Groesse aber anderem SHA-256 nach dem Relay ab', async () => {
    const source = Buffer.from('AAAA', 'utf8');
    const changed = Buffer.from('BBBB', 'utf8');
    fetchMock
      .mockResolvedValueOnce(response(source))
      .mockResolvedValueOnce(response(changed));

    const prepared = await prepareTicketRelayAttachments([{
      id: '1',
      name: 'proof.bin',
      url: 'https://cdn.discordapp.com/attachments/10/11/proof.bin',
      size: source.length,
    }]);

    await expect(verifyTicketRelayAttachments([{
      name: 'proof.bin',
      url: 'https://media.discordapp.net/attachments/20/21/proof.bin',
      size: changed.length,
    }], prepared)).rejects.toThrow('SHA-256');
  });
});
