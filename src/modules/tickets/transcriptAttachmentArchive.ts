const MAX_ARCHIVE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 100 * 1024 * 1024;
const ATTACHMENT_FETCH_TIMEOUT_MS = 20_000;

const DISCORD_ATTACHMENT_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);

const INLINE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);

export interface TranscriptArchivedAttachment {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
  archivedDataUrl: string | null;
}

export interface TranscriptAttachmentMessage {
  attachments: TranscriptArchivedAttachment[];
}

export interface TranscriptAttachmentArchiveStats {
  attachmentCount: number;
  archivedBytes: number;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function normalizedContentType(value: string | null): string {
  const mime = (value ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime
    : 'application/octet-stream';
}

function assertDiscordAttachmentUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Ticket-Anhang hat keine gueltige URL.');
  }
  if (parsed.protocol !== 'https:' || !DISCORD_ATTACHMENT_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Ticket-Anhang verweist nicht auf einen erlaubten Discord-CDN-Host.');
  }
  if (!/^\/(?:ephemeral-)?attachments\//.test(parsed.pathname)) {
    throw new Error('Ticket-Anhang verweist nicht auf einen Discord-Attachment-Pfad.');
  }
  return parsed;
}

function parsedContentLength(response: Response): number | null {
  const raw = response.headers.get('content-length');
  if (raw === null || !/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function hasContentEncoding(response: Response): boolean {
  const value = response.headers.get('content-encoding')?.trim().toLowerCase();
  return Boolean(value && value !== 'identity');
}

export function isInlineTranscriptImage(contentType: string | null): boolean {
  return INLINE_IMAGE_TYPES.has(normalizedContentType(contentType));
}

/**
 * Sichert Discord-Anhaenge VOR dem Loeschen des Ticket-Channels in das persistierte
 * Web-Transcript. Discord-Attachment-URLs sind signiert und laufen ab; deshalb darf
 * transcriptHtml niemals von ihnen als Langzeit-Speicher abhaengen.
 *
 * Fail-closed: HTTP-/Netzwerkfehler, echte Transport-Laengenfehler und Groessenlimits
 * brechen den Close-Flow ab. Discords Attachment.size ist dagegen nur Metadaten-/
 * Preflight-Information und darf nicht als exakter Transport-Hash missbraucht werden:
 * CDN-/HTTP-Auslieferung kann sich durch Content-Encoding von diesem Wert unterscheiden.
 */
export async function archiveTranscriptAttachments(
  messages: TranscriptAttachmentMessage[],
  fetchImpl: FetchLike = fetch,
): Promise<TranscriptAttachmentArchiveStats> {
  const attachments = messages.flatMap(message => message.attachments);
  if (attachments.length === 0) return { attachmentCount: 0, archivedBytes: 0 };

  let declaredTotal = 0;
  for (const attachment of attachments) {
    if (!/^\d{17,20}$/.test(attachment.id)) {
      throw new Error(`Ticket-Anhang ${attachment.name} hat keine gueltige Discord-ID.`);
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0) {
      throw new Error(`Ticket-Anhang ${attachment.name} hat eine ungueltige Groesse.`);
    }
    if (attachment.size > MAX_ARCHIVE_ATTACHMENT_BYTES) {
      throw new Error(`Ticket-Anhang ${attachment.name} ist groesser als 25 MiB und kann nicht sicher archiviert werden.`);
    }
    declaredTotal += attachment.size;
    if (declaredTotal > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error('Ticket-Anhaenge sind zusammen groesser als 100 MiB und koennen nicht sicher archiviert werden.');
    }
    assertDiscordAttachmentUrl(attachment.url);
  }

  let archivedBytes = 0;
  for (const attachment of attachments) {
    const sourceUrl = assertDiscordAttachmentUrl(attachment.url).toString();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(sourceUrl, {
        method: 'GET',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'accept-encoding': 'identity',
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Ticket-Anhang ${attachment.name} konnte nicht archiviert werden: ${detail}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Ticket-Anhang ${attachment.name} konnte nicht archiviert werden (HTTP ${response.status}).`);
    }

    const headerLength = parsedContentLength(response);
    if (headerLength !== null && headerLength > MAX_ARCHIVE_ATTACHMENT_BYTES) {
      throw new Error(`Ticket-Anhang ${attachment.name} ueberschreitet beim Download 25 MiB.`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_ARCHIVE_ATTACHMENT_BYTES) {
      throw new Error(`Ticket-Anhang ${attachment.name} ueberschreitet beim Download 25 MiB.`);
    }
    if (attachment.size > 0 && bytes.length === 0) {
      throw new Error(`Ticket-Anhang ${attachment.name} wurde leer geladen.`);
    }

    // Content-Length beschreibt die uebertragene Representation. Node/undici kann
    // Content-Encoding transparent dekomprimieren; in diesem Fall ist ein Byte-fuer-Byte-
    // Vergleich mit dem Header ungueltig. Bei identity/unencoded Responses ist die
    // Laenge dagegen ein belastbarer Transport-Integritaetscheck.
    if (!hasContentEncoding(response) && headerLength !== null && bytes.length !== headerLength) {
      throw new Error(`Ticket-Anhang ${attachment.name} wurde nicht vollstaendig geladen (${bytes.length}/${headerLength} Bytes).`);
    }

    archivedBytes += bytes.length;
    if (archivedBytes > MAX_ARCHIVE_TOTAL_BYTES) {
      throw new Error('Ticket-Anhaenge ueberschreiten beim Download zusammen 100 MiB.');
    }

    const contentType = normalizedContentType(response.headers.get('content-type') ?? attachment.contentType);
    attachment.contentType = contentType;
    const dataUrlType = isInlineTranscriptImage(contentType) ? contentType : 'application/octet-stream';
    attachment.archivedDataUrl = `data:${dataUrlType};base64,${bytes.toString('base64')}`;
  }

  return { attachmentCount: attachments.length, archivedBytes };
}
