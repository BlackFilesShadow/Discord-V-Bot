import {
  DASHBOARD_TICKET_REPLY_MAX_CHARS,
  decodeTicketMessageContent,
  encodeTicketMessageContent,
} from '../../src/modules/ticket/ticketMessageEnvelope';

describe('ticket message envelope', () => {
  it('keeps legacy text messages byte-for-byte unchanged', () => {
    const raw = 'Hallo 👋 <a:test:123456789012345678>';
    expect(encodeTicketMessageContent(raw, [])).toBe(raw);
    expect(decodeTicketMessageContent(raw)).toEqual({ text: raw, attachments: [], relay: null });
  });

  it('roundtrips attachment metadata and a Discord relay locator', () => {
    const encoded = encodeTicketMessageContent(
      'Bild anbei',
      [{ name: 'screen.png', size: 1234, contentType: 'image/png' }],
      { channelId: '123456789012345678', messageId: '223456789012345678' },
    );

    expect(decodeTicketMessageContent(encoded)).toEqual({
      text: 'Bild anbei',
      attachments: [{ name: 'screen.png', size: 1234, contentType: 'image/png' }],
      relay: { channelId: '123456789012345678', messageId: '223456789012345678' },
    });
  });

  it('fails open to raw legacy text when an envelope is malformed', () => {
    const raw = '[[VBOT_TICKET_MESSAGE_V1]]not-json';
    expect(decodeTicketMessageContent(raw)).toEqual({ text: raw, attachments: [], relay: null });
  });

  it('exposes the expanded dashboard reply limit', () => {
    expect(DASHBOARD_TICKET_REPLY_MAX_CHARS).toBe(8000);
  });
});
