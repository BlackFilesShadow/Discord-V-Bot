import { XMLParser } from 'fast-xml-parser';
import { validateJson, validateXml } from '../../utils/validator';

export type DayzConfigValidationSeverity = 'ERROR' | 'WARNING';

export type DayzConfigValidationCode =
  | 'SYNTAX_INVALID'
  | 'ROOT_INVALID'
  | 'ROOT_EMPTY'
  | 'REQUIRED_FIELD_MISSING'
  | 'NUMBER_INVALID'
  | 'NUMBER_OUT_OF_RANGE'
  | 'MIN_GT_NOMINAL'
  | 'MIN_GT_MAX'
  | 'NOMINAL_OUTSIDE_RANGE'
  | 'QUANTITY_RANGE_INVALID'
  | 'DUPLICATE_IDENTIFIER'
  | 'IDENTIFIER_MISSING'
  | 'REFERENCE_MISSING'
  | 'UNKNOWN_REFERENCE'
  | 'UNUSUAL_LIFETIME'
  | 'JSON_SECTION_INVALID'
  | 'JSON_VERSION_INVALID';

export interface DayzConfigValidationIssue {
  severity: DayzConfigValidationSeverity;
  code: DayzConfigValidationCode;
  path: string;
  message: string;
}

export interface DayzConfigValidationInput {
  path: string;
  name: string;
  content: string;
}

export interface DayzConfigValidationResult {
  path: string;
  fileName: string;
  format: 'XML' | 'JSON' | 'OTHER';
  syntaxValid: boolean;
  validForKnowledge: boolean;
  issues: DayzConfigValidationIssue[];
  identifiers: string[];
  references: string[];
}

const XML = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: false,
});

const XML_FILES = new Set([
  'types.xml',
  'events.xml',
  'globals.xml',
  'cfgweather.xml',
  'cfgspawnabletypes.xml',
]);

function basename(value: string): string {
  return value.replace(/\\/g, '/').split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
}

function asArray<T>(value: T | T[] | null | undefined): T[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function attrName(value: unknown): string | null {
  const row = asObject(value);
  return row ? scalar(row['@_name']) : null;
}

function addIssue(
  result: DayzConfigValidationResult,
  severity: DayzConfigValidationSeverity,
  code: DayzConfigValidationCode,
  path: string,
  message: string,
): void {
  result.issues.push({ severity, code, path, message });
}

function finalize(result: DayzConfigValidationResult): DayzConfigValidationResult {
  result.validForKnowledge = result.syntaxValid && !result.issues.some((issue) => issue.severity === 'ERROR');
  result.identifiers = Array.from(new Set(result.identifiers));
  result.references = Array.from(new Set(result.references));
  return result;
}

function numberField(
  result: DayzConfigValidationResult,
  row: Record<string, unknown>,
  key: string,
  path: string,
  options: { required?: boolean; min?: number; allowMinusOne?: boolean } = {},
): number | null {
  const raw = scalar(row[key]);
  if (raw === null) {
    if (options.required) {
      addIssue(result, 'ERROR', 'REQUIRED_FIELD_MISSING', `${path}.${key}`, `Pflichtfeld ${key} fehlt.`);
    }
    return null;
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    addIssue(result, 'ERROR', 'NUMBER_INVALID', `${path}.${key}`, `${key} ist kein gueltiger Zahlenwert.`);
    return null;
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    addIssue(result, 'ERROR', 'NUMBER_INVALID', `${path}.${key}`, `${key} ist kein endlicher Zahlenwert.`);
    return null;
  }
  const minimum = options.min ?? 0;
  if (value < minimum && !(options.allowMinusOne && value === -1)) {
    addIssue(result, 'ERROR', 'NUMBER_OUT_OF_RANGE', `${path}.${key}`, `${key} liegt ausserhalb des erlaubten Wertebereichs.`);
  }
  return value;
}

function requireIdentifier(
  result: DayzConfigValidationResult,
  entry: unknown,
  path: string,
  seen: Set<string>,
): string | null {
  const name = attrName(entry);
  if (!name) {
    addIssue(result, 'ERROR', 'IDENTIFIER_MISSING', `${path}.@name`, 'Der erforderliche name-Identifier fehlt.');
    return null;
  }
  const key = name.toLowerCase();
  if (seen.has(key)) {
    addIssue(result, 'ERROR', 'DUPLICATE_IDENTIFIER', `${path}.@name`, 'Ein Identifier ist innerhalb derselben Datei mehrfach definiert.');
  } else {
    seen.add(key);
  }
  result.identifiers.push(name);
  return name;
}

function validateTypesXml(result: DayzConfigValidationResult, doc: Record<string, unknown>): void {
  const root = asObject(doc.types);
  if (!root) {
    addIssue(result, 'ERROR', 'ROOT_INVALID', 'types', 'types.xml muss ein <types>-Wurzelelement besitzen.');
    return;
  }
  const entries = asArray(root.type);
  if (entries.length === 0) {
    addIssue(result, 'WARNING', 'ROOT_EMPTY', 'types.type', 'types.xml enthaelt keine <type>-Eintraege.');
    return;
  }

  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const row = asObject(entry);
    const path = `types.type[${index}]`;
    if (!row) {
      addIssue(result, 'ERROR', 'ROOT_INVALID', path, 'type-Eintrag ist strukturell ungueltig.');
      return;
    }
    requireIdentifier(result, row, path, seen);
    const nominal = numberField(result, row, 'nominal', path, { required: true, min: 0 });
    const min = numberField(result, row, 'min', path, { required: true, min: 0 });
    const lifetime = numberField(result, row, 'lifetime', path, { required: true, min: 0 });
    numberField(result, row, 'restock', path, { required: true, min: 0 });
    const quantMin = numberField(result, row, 'quantmin', path, { min: 0, allowMinusOne: true });
    const quantMax = numberField(result, row, 'quantmax', path, { min: 0, allowMinusOne: true });
    numberField(result, row, 'cost', path, { min: 0 });

    if (min !== null && nominal !== null && min > nominal) {
      addIssue(result, 'ERROR', 'MIN_GT_NOMINAL', path, 'min darf nicht groesser als nominal sein.');
    }
    if (quantMin !== null && quantMax !== null && quantMin >= 0 && quantMax >= 0 && quantMin > quantMax) {
      addIssue(result, 'ERROR', 'QUANTITY_RANGE_INVALID', path, 'quantmin darf nicht groesser als quantmax sein.');
    }
    if (lifetime !== null && (lifetime === 0 || lifetime > 15_552_000)) {
      addIssue(result, 'WARNING', 'UNUSUAL_LIFETIME', `${path}.lifetime`, 'lifetime ist ungewoehnlich und sollte gegen die Serverabsicht geprueft werden.');
    }
  });
}

function validateEventsXml(result: DayzConfigValidationResult, doc: Record<string, unknown>): void {
  const root = asObject(doc.events);
  if (!root) {
    addIssue(result, 'ERROR', 'ROOT_INVALID', 'events', 'events.xml muss ein <events>-Wurzelelement besitzen.');
    return;
  }
  const entries = asArray(root.event);
  if (entries.length === 0) {
    addIssue(result, 'WARNING', 'ROOT_EMPTY', 'events.event', 'events.xml enthaelt keine <event>-Eintraege.');
    return;
  }

  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const row = asObject(entry);
    const path = `events.event[${index}]`;
    if (!row) {
      addIssue(result, 'ERROR', 'ROOT_INVALID', path, 'event-Eintrag ist strukturell ungueltig.');
      return;
    }
    requireIdentifier(result, row, path, seen);
    const nominal = numberField(result, row, 'nominal', path, { required: true, min: 0 });
    const min = numberField(result, row, 'min', path, { required: true, min: 0 });
    const max = numberField(result, row, 'max', path, { required: true, min: 0 });
    const lifetime = numberField(result, row, 'lifetime', path, { required: true, min: 0 });
    numberField(result, row, 'restock', path, { required: true, min: 0 });
    for (const key of ['saferadius', 'distanceradius', 'cleanupradius']) {
      numberField(result, row, key, path, { min: 0 });
    }

    if (min !== null && max !== null && min > max) {
      addIssue(result, 'ERROR', 'MIN_GT_MAX', path, 'min darf nicht groesser als max sein.');
    }
    if (nominal !== null && min !== null && max !== null && (nominal < min || nominal > max)) {
      addIssue(result, 'ERROR', 'NOMINAL_OUTSIDE_RANGE', path, 'nominal muss zwischen min und max liegen.');
    }
    if (lifetime !== null && (lifetime === 0 || lifetime > 604_800)) {
      addIssue(result, 'WARNING', 'UNUSUAL_LIFETIME', `${path}.lifetime`, 'Event-lifetime ist ungewoehnlich und sollte geprueft werden.');
    }

    const children = asObject(row.children);
    for (const [childIndex, child] of asArray(children?.child).entries()) {
      const childName = attrName(child);
      if (!childName) {
        addIssue(result, 'ERROR', 'REFERENCE_MISSING', `${path}.children.child[${childIndex}].@name`, 'Event-child besitzt keinen name-Identifier.');
      } else {
        result.references.push(childName);
      }
    }
  });
}

function validateGlobalsXml(result: DayzConfigValidationResult, doc: Record<string, unknown>): void {
  const root = asObject(doc.variables) ?? asObject(doc.globals);
  if (!root) {
    addIssue(result, 'ERROR', 'ROOT_INVALID', 'variables', 'globals.xml muss ein <variables>- oder <globals>-Wurzelelement besitzen.');
    return;
  }
  const entries = asArray(root.var);
  if (entries.length === 0) {
    addIssue(result, 'WARNING', 'ROOT_EMPTY', 'variables.var', 'globals.xml enthaelt keine <var>-Eintraege.');
    return;
  }
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const row = asObject(entry);
    const path = `variables.var[${index}]`;
    if (!row) {
      addIssue(result, 'ERROR', 'ROOT_INVALID', path, 'var-Eintrag ist strukturell ungueltig.');
      return;
    }
    const name = requireIdentifier(result, row, path, seen);
    const value = scalar(row['@_value'] ?? row['#text'] ?? row.value);
    if (value === null) {
      addIssue(result, 'ERROR', 'REQUIRED_FIELD_MISSING', `${path}.value`, 'Globale Variable besitzt keinen Wert.');
    }
    if (name) result.references.push(name);
  });
}

function validateSpawnableTypesXml(result: DayzConfigValidationResult, doc: Record<string, unknown>): void {
  const root = asObject(doc.spawnabletypes);
  if (!root) {
    addIssue(result, 'ERROR', 'ROOT_INVALID', 'spawnabletypes', 'cfgspawnabletypes.xml muss ein <spawnabletypes>-Wurzelelement besitzen.');
    return;
  }
  const entries = asArray(root.type);
  if (entries.length === 0) {
    addIssue(result, 'WARNING', 'ROOT_EMPTY', 'spawnabletypes.type', 'cfgspawnabletypes.xml enthaelt keine <type>-Eintraege.');
    return;
  }
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const row = asObject(entry);
    const path = `spawnabletypes.type[${index}]`;
    if (!row) {
      addIssue(result, 'ERROR', 'ROOT_INVALID', path, 'spawnable type ist strukturell ungueltig.');
      return;
    }
    const name = requireIdentifier(result, row, path, seen);
    if (name) result.references.push(name);

    const collectItems = (value: unknown, childPath: string): void => {
      const block = asObject(value);
      if (!block) return;
      for (const [itemIndex, item] of asArray(block.item).entries()) {
        const itemName = attrName(item);
        if (!itemName) {
          addIssue(result, 'ERROR', 'REFERENCE_MISSING', `${childPath}.item[${itemIndex}].@name`, 'Spawnable-Referenz besitzt keinen name-Identifier.');
        } else {
          result.references.push(itemName);
        }
      }
    };
    collectItems(row.attachments, `${path}.attachments`);
    collectItems(row.cargo, `${path}.cargo`);
  });
}

function validateWeatherXml(result: DayzConfigValidationResult, doc: Record<string, unknown>): void {
  if (!asObject(doc.weather)) {
    addIssue(result, 'ERROR', 'ROOT_INVALID', 'weather', 'cfgweather.xml muss ein <weather>-Wurzelelement besitzen.');
  }
}

function validateXmlFile(input: DayzConfigValidationInput, fileName: string): DayzConfigValidationResult {
  const generic = validateXml(input.content);
  const result: DayzConfigValidationResult = {
    path: input.path,
    fileName,
    format: 'XML',
    syntaxValid: generic.isValid,
    validForKnowledge: false,
    issues: [],
    identifiers: [],
    references: [],
  };
  if (!generic.isValid) {
    for (const error of generic.errors) {
      addIssue(result, 'ERROR', 'SYNTAX_INVALID', error.path ?? '$', error.message);
    }
    return finalize(result);
  }

  let parsed: unknown;
  try {
    parsed = XML.parse(input.content);
  } catch {
    addIssue(result, 'ERROR', 'SYNTAX_INVALID', '$', 'XML konnte trotz Syntaxvorpruefung nicht deterministisch geparst werden.');
    return finalize(result);
  }
  const doc = asObject(parsed);
  if (!doc) {
    addIssue(result, 'ERROR', 'ROOT_INVALID', '$', 'XML-Dokument besitzt keine auswertbare Objektstruktur.');
    return finalize(result);
  }

  switch (fileName) {
    case 'types.xml': validateTypesXml(result, doc); break;
    case 'events.xml': validateEventsXml(result, doc); break;
    case 'globals.xml': validateGlobalsXml(result, doc); break;
    case 'cfgspawnabletypes.xml': validateSpawnableTypesXml(result, doc); break;
    case 'cfgweather.xml': validateWeatherXml(result, doc); break;
    default: break;
  }
  return finalize(result);
}

function validateGameplayJson(input: DayzConfigValidationInput): DayzConfigValidationResult {
  const generic = validateJson(input.content);
  const result: DayzConfigValidationResult = {
    path: input.path,
    fileName: 'cfggameplay.json',
    format: 'JSON',
    syntaxValid: generic.isValid,
    validForKnowledge: false,
    issues: [],
    identifiers: [],
    references: [],
  };
  if (!generic.isValid) {
    for (const error of generic.errors) {
      addIssue(result, 'ERROR', 'SYNTAX_INVALID', error.path ?? '$', error.message);
    }
    return finalize(result);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    addIssue(result, 'ERROR', 'SYNTAX_INVALID', '$', 'JSON konnte trotz Syntaxvorpruefung nicht deterministisch geparst werden.');
    return finalize(result);
  }
  const root = asObject(parsed);
  if (!root) {
    addIssue(result, 'ERROR', 'ROOT_INVALID', '$', 'cfggameplay.json muss ein JSON-Objekt als Wurzel besitzen.');
    return finalize(result);
  }

  if ('version' in root) {
    if (typeof root.version !== 'number' || !Number.isInteger(root.version) || root.version < 0) {
      addIssue(result, 'ERROR', 'JSON_VERSION_INVALID', '$.version', 'version muss eine nichtnegative Ganzzahl sein.');
    }
  } else {
    addIssue(result, 'WARNING', 'REQUIRED_FIELD_MISSING', '$.version', 'version fehlt; Kompatibilitaet sollte geprueft werden.');
  }

  const knownSections = ['GeneralData', 'PlayerData', 'WorldsData', 'BaseBuildingData', 'UIData', 'MapData', 'VehicleData'];
  let sectionCount = 0;
  for (const section of knownSections) {
    if (!(section in root)) continue;
    sectionCount += 1;
    if (!asObject(root[section])) {
      addIssue(result, 'ERROR', 'JSON_SECTION_INVALID', `$.${section}`, `${section} muss ein JSON-Objekt sein.`);
    }
  }
  if (sectionCount === 0) {
    addIssue(result, 'WARNING', 'ROOT_EMPTY', '$', 'Keine bekannte cfgGameplay-Sektion erkannt.');
  }
  return finalize(result);
}

export function validateDayzKnowledgeFile(input: DayzConfigValidationInput): DayzConfigValidationResult {
  const fileName = basename(input.path || input.name);
  if (XML_FILES.has(fileName)) return validateXmlFile(input, fileName);
  if (fileName === 'cfggameplay.json') return validateGameplayJson(input);
  return {
    path: input.path,
    fileName,
    format: 'OTHER',
    syntaxValid: true,
    validForKnowledge: true,
    issues: [],
    identifiers: [],
    references: [],
  };
}

export function validateDayzKnowledgeSet(
  inputs: readonly DayzConfigValidationInput[],
): Map<string, DayzConfigValidationResult> {
  const results = new Map<string, DayzConfigValidationResult>();
  for (const input of inputs) results.set(input.path, validateDayzKnowledgeFile(input));

  const typesResult = Array.from(results.values()).find((result) => result.fileName === 'types.xml' && result.validForKnowledge);
  const knownTypes = new Set((typesResult?.identifiers ?? []).map((value) => value.toLowerCase()));
  if (knownTypes.size === 0) return results;

  for (const result of results.values()) {
    if (result.fileName !== 'events.xml' && result.fileName !== 'cfgspawnabletypes.xml') continue;
    const seen = new Set<string>();
    for (const reference of result.references) {
      const key = reference.toLowerCase();
      if (seen.has(key) || knownTypes.has(key)) continue;
      seen.add(key);
      addIssue(
        result,
        'WARNING',
        'UNKNOWN_REFERENCE',
        `${result.fileName}.reference`,
        `Referenz ${reference} ist im aktiven types.xml nicht definiert; Mod-/Event-Sonderklasse oder Konfigurationsfehler pruefen.`,
      );
    }
    finalize(result);
  }
  return results;
}

export function countDayzValidationIssues(results: Iterable<DayzConfigValidationResult>): {
  errors: number;
  warnings: number;
  rejectedFiles: number;
} {
  let errors = 0;
  let warnings = 0;
  let rejectedFiles = 0;
  for (const result of results) {
    errors += result.issues.filter((issue) => issue.severity === 'ERROR').length;
    warnings += result.issues.filter((issue) => issue.severity === 'WARNING').length;
    if (!result.validForKnowledge) rejectedFiles += 1;
  }
  return { errors, warnings, rejectedFiles };
}
