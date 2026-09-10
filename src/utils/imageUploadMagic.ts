export type SupportedImageKind = {
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  ext: '.png' | '.jpg' | '.gif' | '.webp';
};

/** Detects the actual image format from stable file signatures. */
export function detectSupportedImageKind(buffer: Buffer): SupportedImageKind | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mime: 'image/png', ext: '.png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  if (buffer.length >= 6) {
    const signature = buffer.subarray(0, 6).toString('ascii');
    if (signature === 'GIF87a' || signature === 'GIF89a') return { mime: 'image/gif', ext: '.gif' };
  }
  if (
    buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }
  return null;
}

export function validateSupportedImageUpload(file: { buffer: Buffer; mimetype?: string }):
  | { ok: true; kind: SupportedImageKind }
  | { ok: false; error: string } {
  if (!file.buffer?.length) return { ok: false, error: 'Bilddatei ist leer.' };
  const kind = detectSupportedImageKind(file.buffer);
  if (!kind) return { ok: false, error: 'Dateiinhalt ist kein unterstütztes PNG/JPEG/GIF/WebP-Bild.' };

  const mime = (file.mimetype ?? '').split(';', 1)[0].trim().toLowerCase();
  const mimeMatches = mime === kind.mime || (kind.mime === 'image/jpeg' && mime === 'image/jpg');
  if (!mimeMatches) return { ok: false, error: 'MIME-Type und Bildinhalt stimmen nicht überein.' };
  return { ok: true, kind };
}
