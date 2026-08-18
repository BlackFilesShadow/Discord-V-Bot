export const LIVE_SERVER_KNOWLEDGE_CREATED_BY = 'SYSTEM:AI14_NITRADO_SNAPSHOT';
export const LIVE_SERVER_SOURCE_PREFIX = 'nitrado-mirror://';
export const LIVE_SERVER_VALIDITY_DAYS = 7;
export const LIVE_SERVER_MAX_DOC_CHARS = 16_000;
export const LIVE_SERVER_MAX_PROJECTED_CHARS = 1_400;

const LIVE_SERVER_SOURCE_VERSION_MAX = 100;
const LIVE_SERVER_SNAPSHOT_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const LIVE_SERVER_SHA256_RE = /^[a-f0-9]{64}$/i;
const LIVE_SERVER_SOURCE_VERSION_RE = /^b(0|[1-9]\d*):([A-Za-z0-9._-]{1,64}):([a-f0-9]{8,64})$/i;

export function liveServerSourcePrefixForConnection(nitradoConnId: string): string {
  return `${LIVE_SERVER_SOURCE_PREFIX}${encodeURIComponent(nitradoConnId)}/`;
}

export function liveServerConnectionIdFromSourceRef(sourceRef: string | null | undefined): string | null {
  if (typeof sourceRef !== 'string' || !sourceRef.startsWith(LIVE_SERVER_SOURCE_PREFIX)) return null;
  const rest = sourceRef.slice(LIVE_SERVER_SOURCE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const encoded = rest.slice(0, slash);
  try {
    const decoded = decodeURIComponent(encoded);
    if (!decoded || encodeURIComponent(decoded) !== encoded) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function liveServerSourceVersion(bindingVersion: number, snapshotId: string, sha256: string): string {
  if (!Number.isSafeInteger(bindingVersion) || bindingVersion < 0) {
    throw new Error('Ungueltige LIVE_SERVER-Binding-Version.');
  }
  const snapshot = snapshotId.trim();
  if (!LIVE_SERVER_SNAPSHOT_ID_RE.test(snapshot)) {
    throw new Error('Ungueltige LIVE_SERVER-Snapshot-ID.');
  }
  const hash = sha256.trim().toLowerCase();
  if (!LIVE_SERVER_SHA256_RE.test(hash)) {
    throw new Error('Ungueltiger LIVE_SERVER-SHA256.');
  }
  const prefix = `b${bindingVersion}:${snapshot}:`;
  if (prefix.length + 8 > LIVE_SERVER_SOURCE_VERSION_MAX) {
    throw new Error('LIVE_SERVER-SourceVersion kann nicht sicher serialisiert werden.');
  }
  return `${prefix}${hash}`.slice(0, LIVE_SERVER_SOURCE_VERSION_MAX);
}

export function liveServerBindingVersionFromSourceVersion(sourceVersion: string | null | undefined): number | null {
  if (typeof sourceVersion !== 'string') return null;
  const match = LIVE_SERVER_SOURCE_VERSION_RE.exec(sourceVersion);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isSafeInteger(version) && version >= 0 ? version : null;
}

export function isLiveServerSystemKnowledgeCreatedBy(createdBy: string | null | undefined): boolean {
  return createdBy === LIVE_SERVER_KNOWLEDGE_CREATED_BY;
}

export function isLiveServerSourceRef(sourceRef: string | null | undefined): boolean {
  return typeof sourceRef === 'string' && sourceRef.startsWith(LIVE_SERVER_SOURCE_PREFIX);
}
