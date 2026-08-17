import { createHash } from 'node:crypto';
import {
  DAYZ129_PROVENANCE,
  getDayz129Index,
  type Dayz129Index,
  type Dayz129Map,
} from './dayz129CatalogBase';

export const DAYZ_KNOWLEDGE_PLATFORMS = [
  'PC',
  'XBOX',
  'PLAYSTATION',
  'CROSS_PLATFORM',
  'UNKNOWN',
] as const;

export type DayzKnowledgePlatform = typeof DAYZ_KNOWLEDGE_PLATFORMS[number];
export type DayzKnowledgeValidity = 'VALID' | 'INVALID';

export interface DayzKnowledgeValidationIssue {
  code:
    | 'VERSION_MISSING'
    | 'SOURCE_TAG_MISSING'
    | 'MAP_MISSING'
    | 'FILESET_EMPTY'
    | 'FILE_SIZE_INVALID'
    | 'FILE_SHA256_INVALID';
  message: string;
  map?: Dayz129Map;
  path?: string;
}

export interface DayzKnowledgeFileMetadata {
  map: Dayz129Map;
  mission: string;
  path: string;
  size: number;
  sha256: string;
  version: string;
  platform: DayzKnowledgePlatform;
  sourceTag: string;
}

export interface DayzKnowledgeManifest {
  schemaVersion: 1;
  game: 'DayZ';
  version: string;
  versionFamily: string;
  platform: DayzKnowledgePlatform;
  sourceTag: string;
  valueAndStructureSource: string;
  officialSemanticReference: string;
  sourceRule: string;
  manifestSha256: string;
  fileCount: number;
  maps: Array<{
    map: Dayz129Map;
    mission: string;
    fileCount: number;
  }>;
  verifiedAgainstUserManifest: boolean;
  validity: DayzKnowledgeValidity;
  issues: DayzKnowledgeValidationIssue[];
}

const SHA256_RE = /^[a-f0-9]{64}$/i;
const REQUIRED_MAPS: readonly Dayz129Map[] = ['chernarus', 'livonia', 'sakhal'];

function versionFamily(version: string): string {
  const match = version.match(/^(\d+\.\d+)/);
  return match?.[1] ?? version;
}

/**
 * The embedded ZIP manifest does not prove whether the source was captured from
 * PC, Xbox or PlayStation hosting. AI-12 therefore records UNKNOWN instead of
 * inventing platform applicability. Platform-specific knowledge added later
 * must carry an explicit platform rather than inheriting an assumption here.
 */
export function getDayz129CatalogPlatform(): DayzKnowledgePlatform {
  return 'UNKNOWN';
}

export function validateDayzKnowledgeIndex(index: Dayz129Index): DayzKnowledgeValidationIssue[] {
  const issues: DayzKnowledgeValidationIssue[] = [];
  if (!index.version?.trim()) {
    issues.push({ code: 'VERSION_MISSING', message: 'DayZ-Katalogversion fehlt.' });
  }
  if (!index.sourceTag?.trim()) {
    issues.push({ code: 'SOURCE_TAG_MISSING', message: 'DayZ-Source-Tag fehlt.' });
  }

  for (const map of REQUIRED_MAPS) {
    const mapData = index.maps?.[map];
    if (!mapData) {
      issues.push({ code: 'MAP_MISSING', map, message: `Pflichtkarte ${map} fehlt im DayZ-Katalog.` });
      continue;
    }
    const files = Object.entries(mapData.files ?? {});
    if (files.length === 0) {
      issues.push({ code: 'FILESET_EMPTY', map, message: `Karte ${map} enthaelt keine indexierten Dateien.` });
      continue;
    }
    for (const [path, file] of files) {
      if (!Number.isInteger(file.size) || file.size < 0) {
        issues.push({
          code: 'FILE_SIZE_INVALID',
          map,
          path,
          message: `Ungueltige Dateigroesse fuer ${map}/${path}.`,
        });
      }
      if (!SHA256_RE.test(file.sha256 ?? '')) {
        issues.push({
          code: 'FILE_SHA256_INVALID',
          map,
          path,
          message: `Ungueltiger SHA-256 fuer ${map}/${path}.`,
        });
      }
    }
  }
  return issues;
}

function canonicalManifestMaterial(index: Dayz129Index): string {
  const rows: string[] = [
    `version=${index.version}`,
    `sourceTag=${index.sourceTag}`,
  ];
  for (const map of REQUIRED_MAPS) {
    const mapData = index.maps[map];
    if (!mapData) {
      rows.push(`map=${map}|MISSING`);
      continue;
    }
    rows.push(`map=${map}|mission=${mapData.mission}`);
    for (const [path, file] of Object.entries(mapData.files).sort(([a], [b]) => a.localeCompare(b))) {
      rows.push(`${map}|${path}|${file.size}|${file.sha256.toLowerCase()}`);
    }
  }
  return rows.join('\n');
}

export function computeDayzKnowledgeManifestSha256(index: Dayz129Index = getDayz129Index()): string {
  return createHash('sha256').update(canonicalManifestMaterial(index), 'utf8').digest('hex');
}

export function getDayz129KnowledgeManifest(): DayzKnowledgeManifest {
  const index = getDayz129Index();
  const issues = validateDayzKnowledgeIndex(index);
  const maps = REQUIRED_MAPS
    .filter((map) => Boolean(index.maps[map]))
    .map((map) => ({
      map,
      mission: index.maps[map].mission,
      fileCount: Object.keys(index.maps[map].files).length,
    }));
  return {
    schemaVersion: 1,
    game: 'DayZ',
    version: index.version,
    versionFamily: versionFamily(index.version),
    platform: getDayz129CatalogPlatform(),
    sourceTag: index.sourceTag,
    valueAndStructureSource: DAYZ129_PROVENANCE.valueAndStructureSource,
    officialSemanticReference: DAYZ129_PROVENANCE.officialSemanticReference,
    sourceRule: DAYZ129_PROVENANCE.rule,
    manifestSha256: computeDayzKnowledgeManifestSha256(index),
    fileCount: maps.reduce((sum, entry) => sum + entry.fileCount, 0),
    maps,
    verifiedAgainstUserManifest: index.verifiedAgainstUserManifest === true,
    validity: issues.length === 0 ? 'VALID' : 'INVALID',
    issues,
  };
}

export function getDayz129FileMetadata(
  map: Dayz129Map,
  path: string,
): DayzKnowledgeFileMetadata | null {
  const index = getDayz129Index();
  const mapData = index.maps[map];
  const file = mapData?.files[path];
  if (!mapData || !file) return null;
  return {
    map,
    mission: mapData.mission,
    path,
    size: file.size,
    sha256: file.sha256.toLowerCase(),
    version: index.version,
    platform: getDayz129CatalogPlatform(),
    sourceTag: index.sourceTag,
  };
}
