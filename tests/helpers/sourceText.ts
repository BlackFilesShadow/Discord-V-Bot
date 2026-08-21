/**
 * Normalize source text loaded from disk so architecture/string gates are
 * CRLF/LF-agnostic without weakening semantic assertions.
 */
export function normalizeSourceNewlines(source: string): string {
  return source.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function readSourceNormalized(fs: typeof import('node:fs'), path: string): string {
  return normalizeSourceNewlines(fs.readFileSync(path, 'utf8'));
}
