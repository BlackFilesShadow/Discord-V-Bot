import { createHash } from 'node:crypto';

const RELAY_ATTACHMENT_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);
export const DISCORD_MAX_RELAY_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface TicketRelayAttachmentInput {
  id: string;
  name: string | null;
  url: string;
  size: number;
}

export interface PreparedTicketRelayAttachment {
  name: string;
  bytes: Buffer;
  size: number;
  sha256: string;
}

export interface TicketRelayAttachmentReceipt {
  name: string | null;
  url: string;
  size: number;
}

function attachmentLabel(value: Pick<TicketRelayAttachmentInput, 'id' | 'name'>): string {
  return value.name ?? value.id;
}

function validateAttachmentSize(size: number, label: string): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Ticket-Anhang ${label} hat eine ungueltige Groesse.`);
  }
  if (size > DISCORD_MAX_RELAY_ATTACHMENT_BYTES) {
    throw new Error(`Ticket-Anhang ${label} ist groesser als 25 MiB.`);
  }
}

function validatedDiscordAttachmentUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`Ticket-Anhang ${label} hat keine gueltige URL.`);
  }

  if (
    parsed.protocol !== 'https:'
    || parsed.username !== ''
    || parsed.password !== ''
    || (parsed.port !== '' && parsed.port !== '443')
    || !RELAY_ATTACHMENT_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error(`Ticket-Anhang ${label} verweist nicht auf einen erlaubten Discord-CDN-Host.`);
  }
  if (!/^\/(?:ephemeral-)?attachments\//.test(parsed.pathname)) {
    throw new Error(`Ticket-Anhang ${label} verweist nicht auf einen Discord-Attachment-Pfad.`);
  }
  return parsed;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function downloadDiscordAttachment(rawUrl: string, expectedSize: number, label: string): Promise<Buffer> {
  validateAttachmentSize(expectedSize, label);
  const url = validatedDiscordAttachmentUrl(rawUrl, label);
  const response = await fetch(url, { redirect: 'error' });
  if (!response.ok) {
    throw new Error(`Ticket-Anhang ${label} konnte nicht geladen werden (HTTP ${response.status}).`);
  }

  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength !== expectedSize) {
      throw new Error(`Ticket-Anhang ${label} hat eine unerwartete Content-Length.`);
    }
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== expectedSize) {
    throw new Error(`Ticket-Anhang ${label} hat nach dem Download eine unerwartete Groesse.`);
  }
  return bytes;
}

export async function prepareTicketRelayAttachments(
  attachments: Iterable<TicketRelayAttachmentInput>,
): Promise<PreparedTicketRelayAttachment[]> {
  const prepared: PreparedTicketRelayAttachment[] = [];
  for (const attachment of attachments) {
    const label = attachmentLabel(attachment);
    validateAttachmentSize(attachment.size, label);
    const bytes = await downloadDiscordAttachment(attachment.url, attachment.size, label);
    prepared.push({
      name: attachment.name ?? `attachment-${attachment.id}`,
      bytes,
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
  }
  return prepared;
}

export function preparedTicketRelayFiles(
  attachments: readonly PreparedTicketRelayAttachment[],
): Array<{ attachment: Buffer; name: string }> {
  return attachments.map(attachment => ({ attachment: attachment.bytes, name: attachment.name }));
}

/**
 * Verifiziert nach dem Discord-Upload den tatsaechlich erzeugten CDN-Anhang.
 * Ein erfolgreicher Relay gilt fuer Dateien erst dann als bestaetigt, wenn
 * Groesse und SHA-256 des Zielobjekts exakt mit dem heruntergeladenen
 * Quellobjekt uebereinstimmen.
 */
export async function verifyTicketRelayAttachments(
  receipts: Iterable<TicketRelayAttachmentReceipt>,
  prepared: readonly PreparedTicketRelayAttachment[],
): Promise<void> {
  if (prepared.length === 0) return;
  const relayed = [...receipts];
  if (relayed.length !== prepared.length) {
    throw new Error(`Ticket-Anhang-Verifikation fehlgeschlagen: erwartet ${prepared.length}, erhalten ${relayed.length}.`);
  }

  for (let index = 0; index < prepared.length; index += 1) {
    const source = prepared[index];
    const receipt = relayed[index];
    const label = receipt.name ?? source.name;
    if (receipt.size !== source.size) {
      throw new Error(`Ticket-Anhang ${label} wurde mit abweichender Groesse weitergeleitet.`);
    }
    const targetBytes = await downloadDiscordAttachment(receipt.url, receipt.size, label);
    const targetHash = sha256Hex(targetBytes);
    if (targetHash !== source.sha256) {
      throw new Error(`Ticket-Anhang ${label} stimmt nach dem Relay nicht mit SHA-256 der Quelle ueberein.`);
    }
  }
}
