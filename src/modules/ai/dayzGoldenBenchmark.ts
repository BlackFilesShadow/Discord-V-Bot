import type { DayzHallucinationGuardBundle, LiveServerFact } from './dayzHallucinationGuard';
import type { DayzConfigValidationInput, DayzConfigValidationCode } from './dayzConfigValidation';

export const GOLDEN_DAYZ_BENCHMARK_VERSION = '2026-08-17.v1' as const;

export type GoldenDayzBoundary = 'GENERAL_DAYZ' | 'LIVE_SERVER';

export interface GoldenBoundaryCase {
  id: string;
  category: 'BOUNDARY';
  question: string;
  expected: GoldenDayzBoundary;
}

export interface GoldenValidationCase {
  id: string;
  category: 'VALIDATION';
  files: DayzConfigValidationInput[];
  targetFile: string;
  expectedValidForKnowledge: boolean;
  expectedCodes: DayzConfigValidationCode[];
  forbiddenCodes?: DayzConfigValidationCode[];
}

export interface GoldenLivePreflightCase {
  id: string;
  category: 'LIVE_PREFLIGHT';
  question: string;
  guard: DayzHallucinationGuardBundle | null;
  expectedHandled: boolean;
  mustContain?: string[];
  mustNotContain?: string[];
}

export interface GoldenAnswerValidationCase {
  id: string;
  category: 'ANSWER_VALIDATION';
  question: string;
  answer: string;
  guard: DayzHallucinationGuardBundle | null;
  expectedValid: boolean;
  expectedViolations?: string[];
}

export type GoldenDayzCase =
  | GoldenBoundaryCase
  | GoldenValidationCase
  | GoldenLivePreflightCase
  | GoldenAnswerValidationCase;

const OBSERVED_AT = '2026-08-17T00:00:00.000Z';
const SOURCE = {
  sourceRef: 'nitrado-mirror://c123456789012345678901234/snapshots/golden/types.xml',
  sourceVersion: 'golden-v1',
  observedAt: OBSERVED_AT,
  freshness: 'FRESH',
};

function fact(
  subject: string,
  field: string,
  values: string[],
  kind: LiveServerFact['kind'] = 'TYPE',
): LiveServerFact {
  return {
    key: `${kind}:${subject.toLowerCase()}.${field.toLowerCase()}`,
    kind,
    subject,
    field,
    values,
    sources: [SOURCE],
    conflict: values.length > 1,
  };
}

export function goldenResolvedGuard(
  facts: LiveServerFact[] = [],
  identifiers: string[] = facts.map((row) => row.subject),
): DayzHallucinationGuardBundle {
  return {
    version: 1,
    mode: 'LIVE_SERVER',
    scopeStatus: 'RESOLVED',
    nitradoConnId: 'c123456789012345678901234',
    slot: 2,
    alias: 'Golden Server',
    facts,
    identifiers,
    conflictKeys: facts.filter((row) => row.conflict).map((row) => row.key),
  };
}

export const GOLDEN_DAYZ_BOUNDARY_CASES: readonly GoldenBoundaryCase[] = [
  { id: 'boundary-live-own-nominal', category: 'BOUNDARY', question: 'Was ist M4A1 nominal auf meinem Server?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-our-lifetime', category: 'BOUNDARY', question: 'Welche lifetime hat die M4A1 bei uns?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-slot', category: 'BOUNDARY', question: 'Welcher nominal Wert gilt auf Slot 2 fuer M4A1?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-map', category: 'BOUNDARY', question: 'Welche Map laeuft aktuell auf unserem DayZ Server?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-restart', category: 'BOUNDARY', question: 'Was ist unsere Restartzeit?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-config', category: 'BOUNDARY', question: 'Welche Konfiguration ist derzeit auf unserem Gameserver eingestellt?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-status', category: 'BOUNDARY', question: 'Wie ist der aktuelle Status bei unserem Server?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-min', category: 'BOUNDARY', question: 'Wie hoch ist unser min fuer M4A1?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-max', category: 'BOUNDARY', question: 'Was ist max auf Server 3 fuer das Event?', expected: 'LIVE_SERVER' },
  { id: 'boundary-live-mission', category: 'BOUNDARY', question: 'Welche Mission ist momentan auf meinem Gameserver eingestellt?', expected: 'LIVE_SERVER' },
  { id: 'boundary-general-install', category: 'BOUNDARY', question: 'Wie installiere ich Mods auf meinem Server?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-increase-loot', category: 'BOUNDARY', question: 'Wie erhoehe ich den Loot auf meinem Server?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-change-map', category: 'BOUNDARY', question: 'Wie aendere ich die Map auf meinem Server?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-set-lifetime', category: 'BOUNDARY', question: 'Wie setze ich lifetime in types.xml?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-disable-crosshair', category: 'BOUNDARY', question: 'Wie deaktiviere ich das Crosshair auf meinem Gameserver?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-vanilla', category: 'BOUNDARY', question: 'Was bedeutet nominal in DayZ types.xml allgemein?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-file', category: 'BOUNDARY', question: 'Wofuer ist cfgspawnabletypes.xml zustaendig?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-event', category: 'BOUNDARY', question: 'Wie funktionieren Events in events.xml?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-json', category: 'BOUNDARY', question: 'Wie konfiguriere ich cfggameplay.json?', expected: 'GENERAL_DAYZ' },
  { id: 'boundary-general-restart-howto', category: 'BOUNDARY', question: 'Wie richte ich Restarts fuer meinen Server ein?', expected: 'GENERAL_DAYZ' },
] as const;

const VALID_TYPES = `<types>\n  <type name="M4A1">\n    <nominal>7</nominal><lifetime>28800</lifetime><restock>0</restock><min>3</min>\n    <quantmin>-1</quantmin><quantmax>-1</quantmax><cost>100</cost>\n  </type>\n</types>`;

export const GOLDEN_DAYZ_VALIDATION_CASES: readonly GoldenValidationCase[] = [
  {
    id: 'validation-types-valid', category: 'VALIDATION', targetFile: 'types.xml', expectedValidForKnowledge: true,
    expectedCodes: [], files: [{ path: 'mpmissions/dayzOffline.chernarusplus/db/types.xml', name: 'types.xml', content: VALID_TYPES }],
  },
  {
    id: 'validation-types-min-gt-nominal', category: 'VALIDATION', targetFile: 'types.xml', expectedValidForKnowledge: false,
    expectedCodes: ['MIN_GT_NOMINAL'], files: [{ path: 'types.xml', name: 'types.xml', content: VALID_TYPES.replace('<min>3</min>', '<min>9</min>') }],
  },
  {
    id: 'validation-types-quantity-range', category: 'VALIDATION', targetFile: 'types.xml', expectedValidForKnowledge: false,
    expectedCodes: ['QUANTITY_RANGE_INVALID'], files: [{ path: 'types.xml', name: 'types.xml', content: VALID_TYPES.replace('<quantmin>-1</quantmin><quantmax>-1</quantmax>', '<quantmin>80</quantmin><quantmax>20</quantmax>') }],
  },
  {
    id: 'validation-types-duplicate', category: 'VALIDATION', targetFile: 'types.xml', expectedValidForKnowledge: false,
    expectedCodes: ['DUPLICATE_IDENTIFIER'], files: [{ path: 'types.xml', name: 'types.xml', content: `<types><type name="M4A1"><nominal>7</nominal><lifetime>10</lifetime><restock>0</restock><min>1</min></type><type name="M4A1"><nominal>7</nominal><lifetime>10</lifetime><restock>0</restock><min>1</min></type></types>` }],
  },
  {
    id: 'validation-types-syntax', category: 'VALIDATION', targetFile: 'types.xml', expectedValidForKnowledge: false,
    expectedCodes: ['SYNTAX_INVALID'], files: [{ path: 'types.xml', name: 'types.xml', content: '<types><type name="M4A1"></types>' }],
  },
  {
    id: 'validation-events-range', category: 'VALIDATION', targetFile: 'events.xml', expectedValidForKnowledge: false,
    expectedCodes: ['MIN_GT_MAX', 'NOMINAL_OUTSIDE_RANGE'], files: [{ path: 'events.xml', name: 'events.xml', content: `<events><event name="VehicleOffroadHatchback"><nominal>12</nominal><min>10</min><max>5</max><lifetime>300</lifetime><restock>0</restock></event></events>` }],
  },
  {
    id: 'validation-gameplay-valid', category: 'VALIDATION', targetFile: 'cfggameplay.json', expectedValidForKnowledge: true,
    expectedCodes: [], files: [{ path: 'cfggameplay.json', name: 'cfggameplay.json', content: '{"version":120,"GeneralData":{}}' }],
  },
  {
    id: 'validation-gameplay-version', category: 'VALIDATION', targetFile: 'cfggameplay.json', expectedValidForKnowledge: false,
    expectedCodes: ['JSON_VERSION_INVALID'], files: [{ path: 'cfggameplay.json', name: 'cfggameplay.json', content: '{"version":"120","GeneralData":{}}' }],
  },
  {
    id: 'validation-gameplay-section', category: 'VALIDATION', targetFile: 'cfggameplay.json', expectedValidForKnowledge: false,
    expectedCodes: ['JSON_SECTION_INVALID'], files: [{ path: 'cfggameplay.json', name: 'cfggameplay.json', content: '{"version":120,"PlayerData":[]}' }],
  },
  {
    id: 'validation-cross-file-unknown-ref', category: 'VALIDATION', targetFile: 'events.xml', expectedValidForKnowledge: true,
    expectedCodes: ['UNKNOWN_REFERENCE'], files: [
      { path: 'types.xml', name: 'types.xml', content: VALID_TYPES },
      { path: 'events.xml', name: 'events.xml', content: `<events><event name="AnimalGoat"><nominal>1</nominal><min>0</min><max>2</max><lifetime>300</lifetime><restock>0</restock><children><child name="UnknownGoldenType" /></children></event></events>` },
    ],
  },
] as const;

const NOMINAL_7 = fact('M4A1', 'nominal', ['7']);
const MIN_3 = fact('M4A1', 'min', ['3']);
const NOMINAL_CONFLICT = fact('M4A1', 'nominal', ['7', '9']);

export const GOLDEN_DAYZ_LIVE_PREFLIGHT_CASES: readonly GoldenLivePreflightCase[] = [
  {
    id: 'preflight-exact-nominal', category: 'LIVE_PREFLIGHT', question: 'Was ist nominal von M4A1 auf meinem Server?',
    guard: goldenResolvedGuard([NOMINAL_7, MIN_3]), expectedHandled: true, mustContain: ['M4A1.nominal = 7'], mustNotContain: ['M4A1.min = 3'],
  },
  {
    id: 'preflight-exact-min', category: 'LIVE_PREFLIGHT', question: 'Was ist min von M4A1 auf meinem Server?',
    guard: goldenResolvedGuard([NOMINAL_7, MIN_3]), expectedHandled: true, mustContain: ['M4A1.min = 3'], mustNotContain: ['M4A1.nominal = 7'],
  },
  {
    id: 'preflight-missing-live-fact', category: 'LIVE_PREFLIGHT', question: 'Was ist lifetime von M4A1 auf meinem Server?',
    guard: goldenResolvedGuard([NOMINAL_7]), expectedHandled: true, mustContain: ['nicht sicher bestaetigen'], mustNotContain: ['28800'],
  },
  {
    id: 'preflight-conflicting-fact', category: 'LIVE_PREFLIGHT', question: 'Was ist nominal von M4A1 auf meinem Server?',
    guard: goldenResolvedGuard([NOMINAL_CONFLICT]), expectedHandled: true, mustContain: ['widersprechen'], mustNotContain: ['M4A1.nominal = 7', 'M4A1.nominal = 9'],
  },
  {
    id: 'preflight-unresolved-scope', category: 'LIVE_PREFLIGHT', question: 'Was ist nominal von M4A1 auf meinem Server?',
    guard: { version: 1, mode: 'LIVE_SERVER', scopeStatus: 'UNRESOLVED', nitradoConnId: null, slot: null, alias: null, facts: [], identifiers: [], conflictKeys: [] },
    expectedHandled: true, mustContain: ['Slot', 'Server-Alias'],
  },
  {
    id: 'preflight-general-not-intercepted', category: 'LIVE_PREFLIGHT', question: 'Was bedeutet nominal in types.xml?',
    guard: goldenResolvedGuard([NOMINAL_7]), expectedHandled: false,
  },
  {
    id: 'preflight-no-guard-not-intercepted', category: 'LIVE_PREFLIGHT', question: 'Was ist nominal von M4A1 auf meinem Server?',
    guard: null, expectedHandled: false,
  },
] as const;

export const GOLDEN_DAYZ_ANSWER_VALIDATION_CASES: readonly GoldenAnswerValidationCase[] = [
  {
    id: 'answer-live-correct-value', category: 'ANSWER_VALIDATION', question: 'Was ist nominal von M4A1 auf meinem Server?',
    answer: 'Auf dem Server ist M4A1 nominal = 7.', guard: goldenResolvedGuard([NOMINAL_7]), expectedValid: true,
  },
  {
    id: 'answer-live-hallucinated-value', category: 'ANSWER_VALIDATION', question: 'Was ist nominal von M4A1 auf meinem Server?',
    answer: 'Auf dem Server ist M4A1 nominal = 42.', guard: goldenResolvedGuard([NOMINAL_7]), expectedValid: false,
    expectedViolations: ['UNSUPPORTED_VALUE:M4A1.nominal=42'],
  },
  {
    id: 'answer-live-unknown-identifier', category: 'ANSWER_VALIDATION', question: 'Welche Type ist auf meinem Server relevant?',
    answer: 'type: TotallyInventedGoldenRifle', guard: goldenResolvedGuard([NOMINAL_7], ['M4A1']), expectedValid: false,
    expectedViolations: ['UNSUPPORTED_IDENTIFIER:TotallyInventedGoldenRifle'],
  },
  {
    id: 'answer-live-conflict', category: 'ANSWER_VALIDATION', question: 'Was ist nominal von M4A1 auf meinem Server?',
    answer: 'M4A1 nominal = 7.', guard: goldenResolvedGuard([NOMINAL_CONFLICT]), expectedValid: false,
    expectedViolations: ['CONFLICTING_VERIFIED_SOURCES'],
  },
  {
    id: 'answer-live-missing-fact', category: 'ANSWER_VALIDATION', question: 'Was ist lifetime von M4A1 auf meinem Server?',
    answer: 'M4A1 lifetime = 28800.', guard: goldenResolvedGuard([NOMINAL_7]), expectedValid: false,
    expectedViolations: ['REQUESTED_LIVE_FACT_NOT_VERIFIED'],
  },
  {
    id: 'answer-unresolved-scope', category: 'ANSWER_VALIDATION', question: 'Was ist nominal auf meinem Server?',
    answer: 'Der Wert ist 7.', guard: { version: 1, mode: 'LIVE_SERVER', scopeStatus: 'UNRESOLVED', nitradoConnId: null, slot: null, alias: null, facts: [], identifiers: [], conflictKeys: [] },
    expectedValid: false, expectedViolations: ['LIVE_SCOPE_UNRESOLVED'],
  },
  {
    id: 'answer-general-guard-neutral', category: 'ANSWER_VALIDATION', question: 'Was bedeutet nominal in DayZ?',
    answer: 'nominal beschreibt einen Zielbestand im Central Economy System.', guard: goldenResolvedGuard([NOMINAL_7]), expectedValid: true,
  },
] as const;

export const GOLDEN_DAYZ_BENCHMARK: readonly GoldenDayzCase[] = [
  ...GOLDEN_DAYZ_BOUNDARY_CASES,
  ...GOLDEN_DAYZ_VALIDATION_CASES,
  ...GOLDEN_DAYZ_LIVE_PREFLIGHT_CASES,
  ...GOLDEN_DAYZ_ANSWER_VALIDATION_CASES,
] as const;
