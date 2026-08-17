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
