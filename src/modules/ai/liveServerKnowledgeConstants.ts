export const LIVE_SERVER_KNOWLEDGE_CREATED_BY = 'SYSTEM:AI14_NITRADO_SNAPSHOT';
export const LIVE_SERVER_SOURCE_PREFIX = 'nitrado-mirror://';
export const LIVE_SERVER_VALIDITY_DAYS = 7;
export const LIVE_SERVER_MAX_DOC_CHARS = 16_000;
export const LIVE_SERVER_MAX_PROJECTED_CHARS = 1_400;

export function liveServerSourcePrefixForConnection(nitradoConnId: string): string {
  return `${LIVE_SERVER_SOURCE_PREFIX}${encodeURIComponent(nitradoConnId)}/`;
}

export function isLiveServerSystemKnowledgeCreatedBy(createdBy: string | null | undefined): boolean {
  return createdBy === LIVE_SERVER_KNOWLEDGE_CREATED_BY;
}

export function isLiveServerSourceRef(sourceRef: string | null | undefined): boolean {
  return typeof sourceRef === 'string' && sourceRef.startsWith(LIVE_SERVER_SOURCE_PREFIX);
}

/**
 * Extrahiert die persistierte Nitrado-Connection-ID aus einer systemgenerierten
 * LIVE_SERVER-sourceRef. Fremde/defekte Referenzen werden strikt abgewiesen.
 */
export function liveServerConnectionIdFromSourceRef(sourceRef: string | null | undefined): string | null {
  if (!isLiveServerSourceRef(sourceRef)) return null;
  const raw = sourceRef.slice(LIVE_SERVER_SOURCE_PREFIX.length).split('/', 1)[0];
  if (!raw) return null;
  try {
    const decoded = decodeURIComponent(raw).trim();
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Nitrado-1R stampft die ADM-Binding-Generation als `b<generation>:` in jede
 * LIVE_SERVER-sourceVersion. Unversionierte Legacy-Zeilen und kaputte Werte
 * sind fuer binding-sensitive Retrieval-Zwecke absichtlich ungueltig.
 */
export function liveServerBindingVersionFromSourceVersion(sourceVersion: string | null | undefined): number | null {
  if (typeof sourceVersion !== 'string') return null;
  const match = /^b([0-9]+):/.exec(sourceVersion);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}
