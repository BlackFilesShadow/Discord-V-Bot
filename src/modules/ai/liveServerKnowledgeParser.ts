import { XMLParser } from 'fast-xml-parser';
import { isSensitiveKey, redactText, redactValue } from '../nitrado/mirror/redactor';
import { LIVE_SERVER_MAX_DOC_CHARS } from './liveServerKnowledgeConstants';

export type LiveServerKnowledgeKind =
  | 'SERVER_CONFIG'
  | 'GAMEPLAY_JSON'
  | 'TYPES_XML'
  | 'EVENTS_XML'
  | 'GLOBALS_XML'
  | 'WEATHER_XML'
  | 'SPAWNABLE_TYPES_XML';

export interface LiveServerKnowledgeFileInput {
  path: string;
  name: string;
  sha256: string;
  content: string;
}

export interface ParsedLiveServerKnowledgeDocument {
  kind: LiveServerKnowledgeKind;
  label: string;
  sourceKey: string;
  sourceName: string;
  sha256: string;
  content: string;
}

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: false,
});

const SUPPORTED_BASENAMES = new Set([
  'serverdz.cfg',
  'cfggameplay.json',
  'types.xml',
  'events.xml',
  'globals.xml',
  'cfgweather.xml',
  'cfgspawnabletypes.xml',
]);

const SERVER_CFG_ALLOWLIST = new Set([
  'maxplayers',
  'verifysignatures',
  'forcesamebuild',
  'disablevon',
  'voncodecquality',
  'disable3rdperson',
  'disablecrosshair',
  'serverpersontype',
  'servertime',
  'servertimeacceleration',
  'servernighttimeacceleration',
  'serverdatetime',
  'serverdatetimetype',
  'serverpersontype',
  'instancesid',
  'guaranteedupdates',
  'loginqueueconcurrentplayers',
  'loginqueuemaxplayers',
  'storehouselifetime',
  'storageautofix',
  'enablecfggameplayfile',
  'template',
]);

const EXCLUDED_PATH_RE = /(?:^|\/)(?:backup|backups|cache|logs?|crash|dumps?|archive|archives)(?:\/|$)|\.(?:bak|old|backup|tmp)$/i;
const MISSION_RE = /\b(dayzOffline\.[A-Za-z0-9_.-]+)\b/i;

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
}

function normalizeScalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? redactText(trimmed).slice(0, 240) : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function attrName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  return normalizeScalar((value as Record<string, unknown>)['@_name']);
}

function field(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null;
  return normalizeScalar((obj as Record<string, unknown>)[key]);
}

function namedChildren(obj: unknown, key: string): string[] {
  if (!obj || typeof obj !== 'object') return [];
  return asArray((obj as Record<string, unknown>)[key])
    .map(attrName)
    .filter((v): v is string => Boolean(v));
}

function sourceKey(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const mission = normalized.match(MISSION_RE)?.[1];
  const file = basename(normalized);
  return mission ? `mission/${mission}/${file}` : `server/${file}`;
}

function chunkLines(
  kind: LiveServerKnowledgeKind,
  sourceName: string,
  sourceKeyValue: string,
  sha256: string,
  lines: string[],
): ParsedLiveServerKnowledgeDocument[] {
  const cleanLines = lines.map((line) => redactText(line)).filter(Boolean);
  if (cleanLines.length === 0) return [];
  const header = `LIVE_SERVER ${sourceName} | ${sourceKeyValue}`;
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentChars = header.length + 1;
  for (const line of cleanLines) {
    const next = line.slice(0, Math.max(256, LIVE_SERVER_MAX_DOC_CHARS - header.length - 2));
    if (current.length > 0 && currentChars + next.length + 1 > LIVE_SERVER_MAX_DOC_CHARS) {
      chunks.push(current);
      current = [];
      currentChars = header.length + 1;
    }
    current.push(next);
    currentChars += next.length + 1;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk, index) => ({
    kind,
    label: `Live ${sourceName}${chunks.length > 1 ? ` ${index + 1}/${chunks.length}` : ''}`.slice(0, 60),
    sourceKey: `${sourceKeyValue}${chunks.length > 1 ? `#chunk=${index + 1}` : ''}`,
    sourceName,
    sha256,
    content: `${header}\n${chunk.join('\n')}`,
  }));
}

export function isSupportedLiveServerKnowledgeFile(path: string): boolean {
  const normalized = path.replace(/\\/g, '/');
  return SUPPORTED_BASENAMES.has(basename(normalized)) && !EXCLUDED_PATH_RE.test(normalized);
}

export function detectServerMissionTemplate(content: string): string | null {
  const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const match = withoutComments.match(/\btemplate\s*=\s*["']?([^;"'\s]+)["']?\s*;/i);
  const value = match?.[1]?.trim() ?? '';
  return MISSION_RE.test(value) ? value : null;
}

function parseServerCfg(input: LiveServerKnowledgeFileInput): ParsedLiveServerKnowledgeDocument[] {
  const stripped = input.content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const lines: string[] = [];
  for (const statement of stripped.split(';')) {
    const match = statement.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*([\s\S]*?)\s*$/);
    if (!match) continue;
    const key = match[1];
    const lower = key.toLowerCase();
    if (!SERVER_CFG_ALLOWLIST.has(lower) || isSensitiveKey(key)) continue;
    const raw = match[2].replace(/^["']|["']$/g, '').trim();
    const safe = redactValue(key, raw);
    if (safe === null || safe === undefined) continue;
    lines.push(`${key}=${String(safe).slice(0, 240)}`);
  }
  return chunkLines('SERVER_CONFIG', 'serverDZ.cfg', sourceKey(input.path), input.sha256, lines);
}

function flattenJson(
  value: unknown,
  prefix: string,
  out: string[],
  depth = 0,
): void {
  if (depth > 8 || out.length >= 1500) return;
  if (value === null || value === undefined) return;
  if (Array.isArray(value)) {
    if (value.length <= 16 && value.every((v) => ['string', 'number', 'boolean'].includes(typeof v))) {
      const safeValues = value
        .map((v) => normalizeScalar(v))
        .filter((v): v is string => Boolean(v));
      if (safeValues.length > 0) out.push(`${prefix}=${safeValues.join(',').slice(0, 500)}`);
      return;
    }
    value.slice(0, 80).forEach((entry, index) => flattenJson(entry, `${prefix}[${index}]`, out, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key)) continue;
      flattenJson(entry, prefix ? `${prefix}.${key}` : key, out, depth + 1);
    }
    return;
  }
  const safe = normalizeScalar(value);
  if (safe !== null && prefix) out.push(`${prefix}=${safe}`);
}

function parseGameplayJson(input: LiveServerKnowledgeFileInput): ParsedLiveServerKnowledgeDocument[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    return [];
  }
  const lines: string[] = [];
  flattenJson(parsed, '', lines);
  return chunkLines('GAMEPLAY_JSON', 'cfggameplay.json', sourceKey(input.path), input.sha256, lines);
}

function parseTypesXml(input: LiveServerKnowledgeFileInput): ParsedLiveServerKnowledgeDocument[] {
  let doc: any;
  try { doc = XML.parse(input.content); } catch { return []; }
  const types = asArray(doc?.types?.type);
  const lines: string[] = [];
  for (const entry of types) {
    const name = attrName(entry);
    if (!name) continue;
    const parts = [`type=${name}`];
    for (const key of ['nominal', 'min', 'lifetime', 'restock', 'quantmin', 'quantmax', 'cost']) {
      const v = field(entry, key);
      if (v !== null) parts.push(`${key}=${v}`);
    }
    for (const key of ['category', 'usage', 'value', 'tag']) {
      const names = namedChildren(entry, key);
      if (names.length > 0) parts.push(`${key}=${names.join(',')}`);
    }
    lines.push(parts.join(' | '));
  }
  return chunkLines('TYPES_XML', 'types.xml', sourceKey(input.path), input.sha256, lines);
}

function parseEventsXml(input: LiveServerKnowledgeFileInput): ParsedLiveServerKnowledgeDocument[] {
  let doc: any;
  try { doc = XML.parse(input.content); } catch { return []; }
  const events = asArray(doc?.events?.event);
  const lines: string[] = [];
  for (const entry of events) {
    const name = attrName(entry);
    if (!name) continue;
    const parts = [`event=${name}`];
    for (const key of ['nominal', 'min', 'max', 'lifetime', 'restock', 'saferadius', 'distanceradius', 'cleanupradius', 'limit', 'position', 'active']) {
      const v = field(entry, key);
      if (v !== null) parts.push(`${key}=${v}`);
    }
    const children = asArray((entry as any)?.children?.child)
      .map((child: unknown) => attrName(child))
      .filter((v): v is string => Boolean(v));
    if (children.length > 0) parts.push(`children=${children.slice(0, 80).join(',')}`);
    lines.push(parts.join(' | '));
  }
  return chunkLines('EVENTS_XML', 'events.xml', sourceKey(input.path), input.sha256, lines);
}

function parseGlobalsXml(input: LiveServerKnowledgeFileInput): ParsedLiveServerKnowledgeDocument[] {
  let doc: any;
  try { doc = XML.parse(input.content); } catch { return []; }
  const vars = asArray(doc?.variables?.var ?? doc?.globals?.var);
  const lines: string[] = [];
  for (const entry of vars) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    const name = normalizeScalar(row['@_name']);
    if (!name || isSensitiveKey(name)) continue;
    const value = normalizeScalar(row['@_value'] ?? row['#text'] ?? row.value);
    if (value === null) continue;
    const type = normalizeScalar(row['@_type']);
    lines.push(`global=${name} | value=${String(redactValue(name, value))}${type ? ` | type=${type}` : ''}`);
  }
  return chunkLines('GLOBALS_XML', 'globals.xml', sourceKey(input.path), input.sha256, lines);
}

function flattenXmlScalars(value: unknown, prefix: string, out: string[], depth = 0): void {
  if (depth > 8 || out.length >= 1200 || value === null || value === undefined) return;
  if (Array.isArray(value)) {
    value.slice(0, 120).forEach((entry, index) => flattenXmlScalars(entry, `${prefix}[${index}]`, out, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const cleanKey = key.replace(/^@_/, '');
      if (isSensitiveKey(cleanKey)) continue;
      flattenXmlScalars(entry, prefix ? `${prefix}.${cleanKey}` : cleanKey, out, depth + 1);
    }
    return;
  }
  const safe = normalizeScalar(value);
  if (safe !== null && prefix) out.push(`${prefix}=${safe}`);
}

function parseGenericSafeXml(
  input: LiveServerKnowledgeFileInput,
  kind: 'WEATHER_XML' | 'SPAWNABLE_TYPES_XML',
  display: string,
): ParsedLiveServerKnowledgeDocument[] {
  let doc: unknown;
  try { doc = XML.parse(input.content); } catch { return []; }
  const lines: string[] = [];
  flattenXmlScalars(doc, '', lines);
  return chunkLines(kind, display, sourceKey(input.path), input.sha256, lines);
}

export function parseLiveServerKnowledgeFile(input: LiveServerKnowledgeFileInput): ParsedLiveServerKnowledgeDocument[] {
  if (!isSupportedLiveServerKnowledgeFile(input.path)) return [];
  const file = basename(input.path);
  switch (file) {
    case 'serverdz.cfg': return parseServerCfg(input);
    case 'cfggameplay.json': return parseGameplayJson(input);
    case 'types.xml': return parseTypesXml(input);
    case 'events.xml': return parseEventsXml(input);
    case 'globals.xml': return parseGlobalsXml(input);
    case 'cfgweather.xml': return parseGenericSafeXml(input, 'WEATHER_XML', 'cfgweather.xml');
    case 'cfgspawnabletypes.xml': return parseGenericSafeXml(input, 'SPAWNABLE_TYPES_XML', 'cfgspawnabletypes.xml');
    default: return [];
  }
}

export function chooseLiveServerKnowledgeFiles<T extends { path: string; name: string; content?: string | null }>(
  files: readonly T[],
): T[] {
  const eligible = files.filter((file) => isSupportedLiveServerKnowledgeFile(file.path));
  const serverCfgCandidates = eligible.filter((file) => basename(file.path) === 'serverdz.cfg');
  const serverCfg = serverCfgCandidates.length === 1 ? serverCfgCandidates[0] : null;
  const activeMission = serverCfg?.content ? detectServerMissionTemplate(serverCfg.content) : null;
  const chosen: T[] = [];

  for (const target of SUPPORTED_BASENAMES) {
    const candidates = eligible.filter((file) => basename(file.path) === target);
    if (candidates.length === 0) continue;
    if (candidates.length === 1) {
      chosen.push(candidates[0]);
      continue;
    }
    if (target === 'serverdz.cfg') continue;
    if (activeMission) {
      const missionMatches = candidates.filter((file) => file.path.toLowerCase().includes(activeMission.toLowerCase()));
      if (missionMatches.length === 1) chosen.push(missionMatches[0]);
    }
    // Mehrdeutig ohne eindeutige aktive Mission => fail-closed, nicht mischen.
  }
  if (serverCfg) chosen.push(serverCfg);
  return Array.from(new Map(chosen.map((file) => [file.path, file] as const)).values());
}
