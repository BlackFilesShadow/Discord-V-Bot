export const DASHBOARD_TICKET_REPLY_MAX_CHARS = 8000;

const ENVELOPE_PREFIX = '[[VBOT_TICKET_MESSAGE_V1]]';

export interface StoredTicketAttachment {
  name: string;
  size: number;
  contentType: string | null;
}

export interface TicketRelayLocator {
  channelId: string;
  messageId: string;
}

export interface DecodedTicketMessageContent {
  text: string;
  attachments: StoredTicketAttachment[];
  relay: TicketRelayLocator | null;
}

function validSnowflakeLike(value: unknown): value is string {
  return typeof value === 'string' && /^\d{17,20}$/.test(value);
}

function sanitizeAttachment(value: unknown): StoredTicketAttachment | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > 255) return null;
  if (typeof raw.size !== 'number' || !Number.isSafeInteger(raw.size) || raw.size < 0) return null;
  if (raw.contentType !== null && raw.contentType !== undefined && typeof raw.contentType !== 'string') return null;
  return {
    name: raw.name,
    size: raw.size,
    contentType: typeof raw.contentType === 'string' ? raw.contentType : null,
  };
}

export function encodeTicketMessageContent(
  text: string,
  attachments: readonly StoredTicketAttachment[],
  relay: TicketRelayLocator | null = null,
): string {
  if (attachments.length === 0) return text;
  return ENVELOPE_PREFIX + JSON.stringify({
    v: 1,
    text,
    attachments,
    relay,
  });
}

export function decodeTicketMessageContent(raw: string): DecodedTicketMessageContent {
  if (!raw.startsWith(ENVELOPE_PREFIX)) {
    return { text: raw, attachments: [], relay: null };
  }

  try {
    const parsed = JSON.parse(raw.slice(ENVELOPE_PREFIX.length)) as Record<string, unknown>;
    if (parsed.v !== 1 || typeof parsed.text !== 'string' || !Array.isArray(parsed.attachments)) {
      return { text: raw, attachments: [], relay: null };
    }

    const attachments = parsed.attachments
      .map(sanitizeAttachment)
      .filter((value): value is StoredTicketAttachment => value !== null);

    let relay: TicketRelayLocator | null = null;
    if (parsed.relay && typeof parsed.relay === 'object') {
      const candidate = parsed.relay as Record<string, unknown>;
      if (validSnowflakeLike(candidate.channelId) && validSnowflakeLike(candidate.messageId)) {
        relay = { channelId: candidate.channelId, messageId: candidate.messageId };
      }
    }

    return { text: parsed.text, attachments, relay };
  } catch {
    return { text: raw, attachments: [], relay: null };
  }
}
